import type { RequestContext } from '@higgsfield-mcp/core';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { LoggerPort } from '@higgsfield-mcp/core';
import type { McpToolDependencies } from '@higgsfield-mcp/mcp';
import { createGatewayMcpServer } from '@higgsfield-mcp/mcp';

export interface StdioServerOptions {
  deps: McpToolDependencies;
  logger: LoggerPort;
  /** Builds the per-connection request context (the local tenant in stdio mode). */
  context: () => RequestContext;
  /** Called after the transport closes so the container can stop its workers. */
  onClose?: (() => Promise<void>) | undefined;
}

/**
 * Serves one MCP connection over stdio. stdout is reserved for the JSON-RPC
 * channel: every log line this process emits goes to stderr.
 */
export async function serveStdioServer(options: StdioServerOptions): Promise<{ close: () => Promise<void> }> {
  const handle = serveStdio(() => createGatewayMcpServer(options.deps, options.context()), {
    onerror: (error: Error) => {
      options.logger.error({ event: 'mcp.stdio_error', err: error.name }, 'stdio transport error');
    }
  });
  options.logger.info({ event: 'transport.ready', transport: 'stdio' }, 'MCP server listening on stdio');

  return {
    async close() {
      await handle.close();
      if (options.onClose !== undefined) await options.onClose();
    }
  };
}
