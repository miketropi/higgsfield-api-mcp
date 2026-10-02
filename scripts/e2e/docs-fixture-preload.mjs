/**
 * Preload module for the packaged stdio discovery scenario.
 *
 * The installed CLI under test reads its model catalog from the provider's live public
 * documentation directory. CI has no internet, so this harness-owned preload serves an
 * official-page fixture directory (a JSON map of URL path → Markdown) in place of that
 * host and delegates every other request to the real `fetch`. Nothing in the shipped
 * package changes: the production code has no documentation-URL override, and the
 * fixture only exists in the e2e harness process.
 *
 * Used as `node --import file:///…/docs-fixture-preload.mjs`, with the fixture path in
 * `HF_MCP_E2E_DOCS_FIXTURE`.
 */
import { readFileSync } from 'node:fs';

const fixturePath = process.env['HF_MCP_E2E_DOCS_FIXTURE'];
const docsHost = 'docs.higgsfield.ai';

if (fixturePath !== undefined && fixturePath !== '') {
  const pages = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url;
    const parsed = new URL(url);
    if (parsed.hostname === docsHost) {
      const page = pages[parsed.pathname];
      if (page === undefined) {
        return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      return new Response(page, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
    }
    return realFetch(input, init);
  };
}
