import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface DockerAvailability {
  available: boolean;
  reason?: string;
}

/** True when a Docker daemon answers; integration suites skip (never fake) otherwise. */
export function dockerAvailable(): DockerAvailability {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe', timeout: 15_000 });
    return { available: true };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : 'docker unavailable' };
  }
}

export interface LocalHttpServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Minimal HTTP double used by contract tests. Handlers receive the raw body so a
 * test can assert byte-exact request payloads.
 */
export async function startHttpDouble(
  handler: (request: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Buffer }) => {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }
): Promise<LocalHttpServer> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const result = handler({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks)
      });
      res.writeHead(result.status, { 'content-type': 'application/json', ...(result.headers ?? {}) });
      res.end(result.body === undefined ? '' : JSON.stringify(result.body));
    });
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', resolve);
  await promise;
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async close() {
      const { promise: closed, resolve: done } = Promise.withResolvers<void>();
      server.close(() => done());
      await closed;
    }
  };
}
