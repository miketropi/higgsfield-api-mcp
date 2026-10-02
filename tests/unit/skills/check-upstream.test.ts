import { describe, expect, it } from 'vitest';
import { checkUpstream, type UpstreamTransport } from '@higgsfield-mcp/skills';
import { fakeTransport, REPO_ROOT } from './helpers.js';

const PINNED = 'f83af0bc1d937c8119099a11f8ebbf5e6fb99819';
const version = (text: string): { content: string; encoding: string } => ({
  content: Buffer.from(text, 'utf8').toString('base64'),
  encoding: 'base64'
});

function transport(headSha: string, versionText: string): UpstreamTransport {
  return fakeTransport({
    fetchJson: (url) => {
      if (url.includes('/commits/main')) return Promise.resolve({ sha: headSha });
      if (url.includes('/contents/VERSION')) return Promise.resolve(version(versionText));
      return Promise.reject(new Error(`unexpected url ${url}`));
    }
  });
}

describe('checkUpstream', () => {
  it('reports no drift when main still points at the pinned commit', async () => {
    const report = await checkUpstream({
      repoRoot: REPO_ROOT,
      repository: 'higgsfield-ai/skills',
      log: () => undefined,
      transport: transport(PINNED, '0.13.0\n')
    });
    expect(report).toEqual({ pinnedCommit: PINNED, upstreamHead: PINNED, upstreamVersion: '0.13.0', drifted: false });
  });

  it('reports drift when the branch head or the release version moved', async () => {
    const moved = await checkUpstream({
      repoRoot: REPO_ROOT,
      repository: 'higgsfield-ai/skills',
      log: () => undefined,
      transport: transport('0'.repeat(40), '0.13.0\n')
    });
    expect(moved.drifted).toBe(true);
    const released = await checkUpstream({
      repoRoot: REPO_ROOT,
      repository: 'higgsfield-ai/skills',
      log: () => undefined,
      transport: transport(PINNED, '0.14.0\n')
    });
    expect(released.drifted).toBe(true);
    expect(released.upstreamVersion).toBe('0.14.0');
  });

  it('treats a network failure as an error, never as "in sync"', async () => {
    await expect(
      checkUpstream({
        repoRoot: REPO_ROOT,
        repository: 'higgsfield-ai/skills',
        log: () => undefined,
        transport: fakeTransport()
      })
    ).rejects.toThrow(/test transport has no JSON/);
  });

  it('refuses to report drift for a repository other than the pinned one', async () => {
    await expect(
      checkUpstream({
        repoRoot: REPO_ROOT,
        repository: 'someone-else/skills',
        log: () => undefined,
        transport: transport(PINNED, '0.13.0\n')
      })
    ).rejects.toThrow(/Refusing to check/);
  });

  it('rejects an unexpected API payload', async () => {
    await expect(
      checkUpstream({
        repoRoot: REPO_ROOT,
        repository: 'higgsfield-ai/skills',
        log: () => undefined,
        transport: fakeTransport({ fetchJson: () => Promise.resolve({ message: 'Not Found' }) })
      })
    ).rejects.toThrow(/unexpected payload/);
  });
});
