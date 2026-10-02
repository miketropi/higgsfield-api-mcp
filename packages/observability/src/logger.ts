import { hostname } from 'node:os';
import pino from 'pino';
import { REDACTION_CENSOR, safeUrlForLogging, type LoggerPort } from '@higgsfield-mcp/core';

export interface LoggerOptions {
  /** Pino level name; anything unknown falls back to `info`. */
  level: string;
  /**
   * Accepted for configuration compatibility. `pino-pretty` is deliberately
   * not a dependency, so pretty mode still emits single-line JSON (to stderr).
   * See {@link describePrettySupport}.
   */
  pretty: boolean;
  serviceName: string;
  /** Extra bindings merged over the default base fields. */
  base?: Record<string, unknown>;
}

const LEVEL_NAMES: Record<string, true> = {
  trace: true,
  debug: true,
  info: true,
  warn: true,
  error: true,
  fatal: true,
  silent: true
};

/**
 * Values that are never logged. Wildcards cover one nesting level, which is
 * where request, provider, and webhook payloads carry their credentials.
 */
const REDACT_PATHS = [
  'authorization',
  'Authorization',
  '*.authorization',
  '*.*.authorization',
  'headers.authorization',
  '*.headers.authorization',
  '*.*.headers.authorization',
  'credentials',
  '*.credentials',
  '*.*.credentials',
  'token',
  '*.token',
  '*.*.token',
  'secret',
  '*.secret',
  '*.*.secret',
  'password',
  '*.password',
  '*.*.password',
  'apiKey',
  'api_key',
  '*.apiKey',
  '*.api_key',
  '*.*.apiKey',
  '*.accessKeyId',
  '*.secretAccessKey',
  'upload_headers',
  '*.upload_headers',
  '*.*.upload_headers',
  'cookie',
  '*.cookie'
];

/** Keys whose string value is a URL: the query string may be a credential. */
const URL_KEY_PATTERN = /url$/i;
const MAX_URL_WALK_DEPTH = 3;

/**
 * Replaces every URL-valued key with `safeUrlForLogging` output so a signed
 * upload or asset URL can never leak its query string. Containers are copied
 * rather than mutated: the caller still owns the object it logged.
 */
function sanitizeUrlFields(object: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (typeof value === 'string' && URL_KEY_PATTERN.test(key)) {
      output[key] = safeUrlForLogging(value);
      continue;
    }
    if (depth >= MAX_URL_WALK_DEPTH || value === null || typeof value !== 'object') {
      output[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value.map((item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? sanitizeUrlFields(item as Record<string, unknown>, depth + 1)
          : item
      );
      continue;
    }
    output[key] = sanitizeUrlFields(value as Record<string, unknown>, depth + 1);
  }
  return output;
}

/**
 * `pino-pretty` is intentionally absent from the dependency list, so human
 * formatting is never available and the option degrades to JSON on stderr.
 */
export function describePrettySupport(): boolean {
  return false;
}

function toLoggerPort(logger: pino.Logger): LoggerPort {
  return {
    debug: (obj, msg) => {
      if (msg === undefined) logger.debug(obj);
      else logger.debug(obj, msg);
    },
    info: (obj, msg) => {
      if (msg === undefined) logger.info(obj);
      else logger.info(obj, msg);
    },
    warn: (obj, msg) => {
      if (msg === undefined) logger.warn(obj);
      else logger.warn(obj, msg);
    },
    error: (obj, msg) => {
      if (msg === undefined) logger.error(obj);
      else logger.error(obj, msg);
    },
    child: (bindings) => toLoggerPort(logger.child(bindings))
  };
}

/**
 * Creates the process logger.
 *
 * Logs always go to **stderr**: in stdio mode stdout is the MCP JSON-RPC
 * channel, and a single log line written there corrupts the protocol stream.
 */
export function createLogger(options: LoggerOptions): LoggerPort {
  const level = LEVEL_NAMES[options.level] === true ? options.level : 'info';
  const logger = pino(
    {
      level,
      base: { pid: process.pid, hostname: hostname(), service: options.serviceName, ...options.base },
      redact: { paths: REDACT_PATHS, censor: REDACTION_CENSOR },
      formatters: {
        log: (object) => sanitizeUrlFields(object),
        bindings: (bindings) => sanitizeUrlFields(bindings as Record<string, unknown>)
      }
    },
    process.stderr
  );
  return toLoggerPort(logger);
}
