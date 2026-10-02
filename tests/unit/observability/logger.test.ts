import { describe, expect, it } from 'vitest';
import { createLogger, describePrettySupport } from '@higgsfield-mcp/observability';

const SENTINEL = 'sk-sentinel-0123456789abcdef';
const SIGNED_URL = `https://storage.example.com/media/out.png?X-Amz-Signature=${SENTINEL}&X-Amz-Credential=${SENTINEL}`;

interface CapturedLogs {
  stdout: string;
  stderr: string;
}

/**
 * Swaps the stream write functions for the duration of `run`. Both streams are
 * still the same objects the logger holds; only their write method changes
 * address, which is exactly the seam pino uses at log time.
 */
function captureLogs(run: () => void): CapturedLogs {
  let stdout = '';
  let stderr = '';
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: string) => {
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    stderr += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { stdout, stderr };
}

function loggerAt(level = 'debug') {
  return createLogger({ level, pretty: false, serviceName: 'higgsfield-mcp' });
}

describe('createLogger', () => {
  it('redacts credentials, authorization headers, and upload headers', () => {
    const logs = captureLogs(() => {
      loggerAt().info({
        authorization: `Bearer ${SENTINEL}`,
        credentials: { apiKey: SENTINEL },
        upload_headers: { Authorization: `Bearer ${SENTINEL}` },
        headers: { authorization: `Bearer ${SENTINEL}` },
        nested: { token: SENTINEL, password: SENTINEL, secret: SENTINEL }
      });
    });

    expect(logs.stderr).not.toContain(SENTINEL);
    expect(logs.stderr).toContain('[redacted]');
    expect(logs.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('strips query strings from URL-valued keys', () => {
    const logs = captureLogs(() => {
      loggerAt().info({ url: SIGNED_URL, image_url: SIGNED_URL, nested: { assetUrl: SIGNED_URL } });
    });

    expect(logs.stderr).not.toContain(SENTINEL);
    expect(logs.stderr).not.toContain('X-Amz-Signature');
    expect(logs.stderr).toContain('https://storage.example.com/media/out.png?[redacted]');
  });

  it('redacts child bindings too', () => {
    const logs = captureLogs(() => {
      const child = loggerAt().child({ authorization: `Bearer ${SENTINEL}` });
      child.error({ message: 'failed' }, 'provider call failed');
    });

    expect(logs.stderr).not.toContain(SENTINEL);
    expect(logs.stderr).toContain('provider call failed');
  });

  it('writes to stderr only, never to stdout', () => {
    const logs = captureLogs(() => {
      loggerAt().info({ event: 'generation.completed' }, 'job finished');
    });

    expect(logs.stdout).toBe('');
    expect(logs.stderr).toContain('job finished');
    expect(logs.stderr).toContain('generation.completed');
  });

  it('keeps pretty mode on stderr as single-line JSON', () => {
    const logs = captureLogs(() => {
      createLogger({ level: 'info', pretty: true, serviceName: 'higgsfield-mcp' }).info({ event: 'startup' });
    });

    expect(logs.stdout).toBe('');
    expect(logs.stderr.trim().split('\n')).toHaveLength(1);
    const record = JSON.parse(logs.stderr.trim()) as Record<string, unknown>;
    expect(record['event']).toBe('startup');
    expect(record['service']).toBe('higgsfield-mcp');
    expect(describePrettySupport()).toBe(false);
  });

  it('applies the level and falls back to info for unknown levels', () => {
    const quiet = captureLogs(() => {
      createLogger({ level: 'warn', pretty: false, serviceName: 'svc' }).info({ event: 'ignored' });
    });
    const fallback = captureLogs(() => {
      createLogger({ level: 'verbose', pretty: false, serviceName: 'svc' }).info({ event: 'emitted' });
    });

    expect(quiet.stderr).toBe('');
    expect(fallback.stderr).toContain('emitted');
  });

  it('merges extra base bindings over the defaults', () => {
    const logs = captureLogs(() => {
      createLogger({ level: 'info', pretty: false, serviceName: 'svc', base: { region: 'eu-central-1' } }).warn({ event: 'degraded' });
    });

    const record = JSON.parse(logs.stderr.trim()) as Record<string, unknown>;
    expect(record['service']).toBe('svc');
    expect(record['region']).toBe('eu-central-1');
    expect(record['hostname']).toBeTypeOf('string');
  });

  it('does not mutate the object it was given', () => {
    const payload: Record<string, unknown> = { url: SIGNED_URL };
    captureLogs(() => {
      loggerAt().info(payload);
    });
    expect(payload['url']).toBe(SIGNED_URL);
  });
});
