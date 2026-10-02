import { serveStdioServer } from '../../../apps/server/src/transport/stdio.js';
import { createTestDeps, stdioContext } from '../harness/deps.js';

/**
 * Child-process entry for the stdio protocol gate. It builds the in-memory gateway
 * graph and serves one stdio connection; nothing is ever written to stdout except
 * protocol traffic.
 */
const graph = createTestDeps({ localFileAccess: true });
const handle = await serveStdioServer({
  deps: graph.deps,
  logger: graph.logger,
  context: stdioContext
});

process.on('SIGTERM', () => {
  void handle.close().then(() => process.exit(0));
});
