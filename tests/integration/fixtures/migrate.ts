import type { LoggerPort } from '@higgsfield-mcp/core';
import { runMigrations } from '@higgsfield-mcp/core';

const connectionString = process.env['HF_MCP_DATABASE_URL'];
if (connectionString === undefined) {
  process.stderr.write('HF_MCP_DATABASE_URL is required\n');
  process.exit(2);
}

const logger: LoggerPort = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  }
};

const result = await runMigrations({ connectionString, logger });
process.stdout.write(`applied:${result.applied.join(',')}\n`);
