import { join } from 'node:path';
import { z } from 'zod';
import { SkillsError } from './errors.js';
import { loadManifest } from './manifest.js';
import { createHttpTransport, GITHUB_API_BASE, type UpstreamTransport } from './transport.js';

export interface CheckUpstreamOptions {
  repoRoot: string;
  repository: string;
  log: (line: string) => void;
  /** Injectable network seam. Defaults to the GitHub HTTP transport. */
  transport?: UpstreamTransport | undefined;
  apiBase?: string | undefined;
}

export interface CheckUpstreamResult {
  pinnedCommit: string;
  upstreamHead: string;
  upstreamVersion: string;
  drifted: boolean;
}

const commitSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
const contentsSchema = z.object({ content: z.string().min(1), encoding: z.string().optional() });

/**
 * Reports drift without touching a file: the pinned commit and `VERSION` come from the
 * manifest, the HEAD commit and `VERSION` from the GitHub API. A network failure is an
 * error, never a silent "in sync".
 */
export async function checkUpstream(options: CheckUpstreamOptions): Promise<CheckUpstreamResult> {
  const manifest = loadManifest(join(options.repoRoot, 'packages', 'skills'));
  const repository = options.repository.trim();
  if (repository !== manifest.upstream.repository) {
    throw new SkillsError(
      `Refusing to check "${repository}": the manifest pins ${manifest.upstream.repository}. Checking a different repository would report meaningless drift.`
    );
  }
  const transport = options.transport ?? createHttpTransport({ token: process.env['GITHUB_TOKEN'] ?? undefined });
  const base = options.apiBase ?? GITHUB_API_BASE;
  const pinnedCommit = manifest.upstream.commit;

  options.log(`skills: pinned ${manifest.upstream.repository}@${pinnedCommit} (v${manifest.upstream.version})`);
  const head = commitSchema.safeParse(await transport.fetchJson(`${base}/repos/${repository}/commits/main`));
  if (!head.success) throw new SkillsError(`${base}/repos/${repository}/commits/main returned an unexpected payload.`);
  const headContents = contentsSchema.safeParse(await transport.fetchJson(`${base}/repos/${repository}/contents/VERSION?ref=main`));
  if (!headContents.success) throw new SkillsError(`${base}/repos/${repository}/contents/VERSION returned an unexpected payload.`);
  const upstreamVersion = Buffer.from(headContents.data.content, headContents.data.encoding === 'base64' ? 'base64' : 'utf8')
    .toString('utf8')
    .trim();
  if (upstreamVersion.length === 0) throw new SkillsError(`${repository}: VERSION at main is empty.`);

  const drifted = head.data.sha !== pinnedCommit || upstreamVersion !== manifest.upstream.version;
  if (drifted) {
    options.log(
      `skills: upstream moved — head ${head.data.sha} (v${upstreamVersion}), pinned ${pinnedCommit} (v${manifest.upstream.version}). ` +
        'Open a compatibility PR: review the diff, update the manifest and patches, then sync.'
    );
  } else {
    options.log('skills: in sync with upstream main');
  }
  return { pinnedCommit, upstreamHead: head.data.sha, upstreamVersion, drifted };
}
