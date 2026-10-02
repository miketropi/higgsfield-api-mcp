import { execFileSync } from 'node:child_process';
import { dockerAvailable } from './services.js';

const POSTGRES_IMAGE = 'postgres:16-alpine';

export interface DisposablePostgres {
  url: string;
  containerId: string;
  stop: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const randomPort = (): number => 20_000 + Math.floor(Math.random() * 20_000);

/**
 * Starts a throwaway PostgreSQL container bound to loopback. The suite skips (never
 * fakes) when the Docker daemon is unavailable.
 */
export async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const availability = dockerAvailable();
  if (!availability.available) {
    throw new Error(`docker unavailable: ${availability.reason ?? 'unknown'}`);
  }
  const port = randomPort();
  const containerId = execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '-e',
      'POSTGRES_PASSWORD=replay',
      '-e',
      'POSTGRES_USER=replay',
      '-e',
      'POSTGRES_DB=replay',
      '-p',
      `127.0.0.1:${port}:5432`,
      POSTGRES_IMAGE
    ],
    { encoding: 'utf8', timeout: 120_000 }
  ).trim();

  const url = `postgres://replay:replay@127.0.0.1:${port}/replay`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      execFileSync('docker', ['exec', containerId, 'pg_isready', '-U', 'replay'], { stdio: 'pipe', timeout: 10_000 });
      return {
        url,
        containerId,
        async stop() {
          try {
            execFileSync('docker', ['rm', '-f', containerId], { stdio: 'pipe', timeout: 60_000 });
          } catch {
            // already gone (--rm) or the daemon vanished; nothing to clean up
          }
        }
      };
    } catch {
      await sleep(1_000);
    }
  }
  execFileSync('docker', ['rm', '-f', containerId], { stdio: 'pipe', timeout: 60_000 });
  throw new Error('postgres container did not become ready');
}
