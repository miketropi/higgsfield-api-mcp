import { constants, open, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { LoggerPort, MediaType } from '../contracts.js';
import { GatewayError } from '../errors.js';
import { sha256Hex } from '../ids.js';
import { isAllowedUploadMimeType, mediaTypeForMime, sniffMimeType } from './mime.js';

export interface MediaFileMeta {
  /** Fully resolved path that the bytes were actually read from. */
  realPath: string;
  size: number;
  mimeType: string;
  mediaType: MediaType;
  /** sha256 hex of the file bytes. */
  digest: string;
}

export interface MediaFileSource extends MediaFileMeta {
  bytes: Uint8Array;
}

export interface LocalFileReader {
  /** Reads and validates an allowlisted file. Every failure is a GatewayError. */
  read(path: string): Promise<MediaFileSource>;
  /** Digest + type without uploading; memoized on realpath+size+mtime. */
  identify(path: string): Promise<MediaFileMeta>;
}

export interface LocalFileReaderOptions {
  allowedPaths: readonly string[];
  localFileAccess: boolean;
  maxBytes: number;
  logger: LoggerPort;
}

/** Bounds the digest memo so a long-running server cannot grow without limit. */
const MAX_MEMO_ENTRIES = 512;

function invalidInput(message: string): GatewayError {
  return new GatewayError('INVALID_INPUT', message);
}

/**
 * `path.relative` returning a value that starts with `..` (or is absolute) means
 * the candidate escapes the root; an empty result means the candidate *is* the
 * root, which is a directory and therefore never a valid media file.
 */
function isContained(root: string, candidate: string): boolean {
  const step = relative(root, candidate);
  return step !== '' && !step.startsWith('..') && !isAbsolute(step);
}

/**
 * Reads media bytes from disk under a strict allowlist.
 *
 * Hardening, in order: configured roots are `realpath`-resolved and cached; the
 * candidate is resolved before any check so symlinks cannot smuggle it out of a
 * root; containment is re-checked on the resolved path; the file is opened with
 * `O_NOFOLLOW` so the final component cannot be a symlink; the opened handle's
 * `dev`/`ino` must match a fresh `stat` of the resolved path (a swap between
 * check and open is rejected); the original path is re-resolved after the open;
 * bytes are read from the handle only, capped at `maxBytes + 1`, and the handle
 * is re-`fstat`ed afterwards so a file modified mid-read is rejected.
 */
export function createLocalFileReader(options: LocalFileReaderOptions): LocalFileReader {
  let roots: string[] | undefined;
  const digests = new Map<string, MediaFileMeta>();

  const rememberMeta = (key: string, meta: MediaFileMeta): void => {
    if (digests.size >= MAX_MEMO_ENTRIES) {
      const oldest = digests.keys().next();
      if (!oldest.done) digests.delete(oldest.value);
    }
    digests.set(key, meta);
  };

  const resolveRoots = async (): Promise<string[]> => {
    if (roots !== undefined) return roots;
    const resolved: string[] = [];
    for (const root of options.allowedPaths) {
      try {
        resolved.push(await realpath(resolve(root)));
      } catch {
        // A configured root that does not exist cannot authorize anything.
        options.logger.warn({ root }, 'Configured media root is not readable and was ignored.');
      }
    }
    roots = resolved;
    return roots;
  };

  const authorize = async (candidate: string): Promise<string> => {
    if (!options.localFileAccess) {
      throw invalidInput('Local file access is disabled for this transport; use an asset or an https URL.');
    }
    if (options.allowedPaths.length === 0) {
      throw invalidInput('No allowed media paths are configured; local file access is denied.');
    }

    const absolute = resolve(candidate);
    let resolvedCandidate: string;
    try {
      resolvedCandidate = await realpath(absolute);
    } catch {
      throw invalidInput('The requested media file does not exist.');
    }

    const allowedRoots = await resolveRoots();
    if (!allowedRoots.some((root) => isContained(root, resolvedCandidate))) {
      throw invalidInput('The requested media file is outside the configured allowed paths.');
    }
    return resolvedCandidate;
  };

  const read = async (path: string): Promise<MediaFileSource> => {
    const resolvedCandidate = await authorize(path);

    const handle = await open(resolvedCandidate, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    if (handle === undefined) {
      throw invalidInput('The requested media file could not be opened as a regular file.');
    }

    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw invalidInput('Only regular files can be used as media input.');
      if (opened.size === 0) throw invalidInput('The requested media file is empty.');
      if (opened.size > options.maxBytes) {
        throw invalidInput(`The requested media file exceeds the ${options.maxBytes} byte upload limit.`);
      }

      const onDisk = await stat(resolvedCandidate);
      if (onDisk.dev !== opened.dev || onDisk.ino !== opened.ino) {
        throw invalidInput('The requested media file changed while it was being opened.');
      }
      // `/proc/self/fd/<n>` is a symlink to the opened file on Linux. Comparing
      // it with the checked path closes the window where a path component is
      // swapped between the realpath check and the open; platforms without it
      // fall back to the dev/ino comparison above.
      const viaDescriptor = await readlink(`/proc/self/fd/${handle.fd}`)
        .then((link) => realpath(link))
        .catch(() => undefined);
      if (viaDescriptor !== undefined && viaDescriptor !== resolvedCandidate) {
        throw invalidInput('The requested media file changed while it was being opened.');
      }
      const stillResolved = await realpath(resolve(path)).catch(() => '');
      if (stillResolved !== resolvedCandidate) {
        throw invalidInput('The requested media file changed while it was being opened.');
      }

      const buffer = Buffer.allocUnsafe(Math.min(opened.size, options.maxBytes) + 1);
      let filled = 0;
      while (filled < buffer.byteLength) {
        const readChunk = await handle.read(buffer, filled, buffer.byteLength - filled, filled);
        if (readChunk.bytesRead === 0) break;
        filled += readChunk.bytesRead;
      }
      if (filled > options.maxBytes) {
        throw invalidInput(`The requested media file exceeds the ${options.maxBytes} byte upload limit.`);
      }
      if (filled !== opened.size) {
        throw invalidInput('The requested media file changed while it was being read.');
      }

      const afterRead = await handle.stat();
      if (afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs) {
        throw invalidInput('The requested media file changed while it was being read.');
      }

      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, filled);
      const mimeType = sniffMimeType(bytes);
      if (mimeType === undefined || !isAllowedUploadMimeType(mimeType)) {
        throw invalidInput('Unsupported media type: the file content is not a supported image, audio, or video type.');
      }
      const mediaType = mediaTypeForMime(mimeType);
      if (mediaType === undefined) {
        throw invalidInput('Unsupported media type: the file content is not a supported media type.');
      }

      return {
        bytes,
        realPath: resolvedCandidate,
        size: filled,
        mimeType,
        mediaType,
        digest: sha256Hex(bytes)
      };
    } finally {
      await handle.close();
    }
  };

  const identify = async (path: string): Promise<MediaFileMeta> => {
    const resolvedCandidate = await authorize(path);
    const info = await stat(resolvedCandidate).catch(() => undefined);
    if (info === undefined || !info.isFile()) throw invalidInput('Only regular files can be used as media input.');
    if (info.size === 0) throw invalidInput('The requested media file is empty.');
    if (info.size > options.maxBytes) {
      throw invalidInput(`The requested media file exceeds the ${options.maxBytes} byte upload limit.`);
    }

    const memoKey = `${resolvedCandidate}:${info.size}:${info.mtimeMs}`;
    const memoized = digests.get(memoKey);
    if (memoized !== undefined) return memoized;

    const source = await read(path);
    const meta: MediaFileMeta = {
      realPath: source.realPath,
      size: source.size,
      mimeType: source.mimeType,
      mediaType: source.mediaType,
      digest: source.digest
    };
    rememberMeta(memoKey, meta);
    return meta;
  };

  return { read, identify };
}
