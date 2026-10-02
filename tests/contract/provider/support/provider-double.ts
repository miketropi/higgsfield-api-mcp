/**
 * Local `node:http` double for the Higgsfield contract tests.
 *
 * No real network, no paid calls, no environment mutation: every stub response is
 * scripted by the test and every request is recorded byte-for-byte (method, path,
 * query, raw header list and raw body buffer).
 */
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedCall {
  method: string;
  /** Path plus query string, exactly as received. */
  url: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  /** Alternating name/value list, preserving duplicates and original casing. */
  rawHeaders: string[];
  body: Buffer;
}

export interface StubResponse {
  status: number;
  headers?: Record<string, string>;
  /** Objects are JSON-encoded; strings are sent verbatim; omitted means an empty body. */
  body?: unknown;
}

export type Stub = StubResponse | ((call: RecordedCall, index: number) => StubResponse);

/** All raw header values received for `name`, case-insensitively. */
export function headersNamed(call: RecordedCall, name: string): string[] {
  const wanted = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index + 1 < call.rawHeaders.length; index += 2) {
    if (call.rawHeaders[index]?.toLowerCase() === wanted) values.push(call.rawHeaders[index + 1] ?? '');
  }
  return values;
}

export class ProviderDouble {
  readonly calls: RecordedCall[] = [];

  private readonly stubs: Stub[] = [];
  private server: Server | undefined;
  private origin: string | undefined;

  static async start(...stubs: Stub[]): Promise<ProviderDouble> {
    const double = new ProviderDouble();
    double.stub(...stubs);
    await double.listen();
    return double;
  }

  /** Queues responses; the last stub is reused once the queue is exhausted. */
  stub(...responses: Stub[]): void {
    this.stubs.push(...responses);
  }

  get baseUrl(): string {
    if (this.origin === undefined) throw new Error('The provider double is not listening.');
    return this.origin;
  }

  get lastCall(): RecordedCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  private async listen(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const url = request.url ?? '/';
    const separator = url.indexOf('?');
    const call: RecordedCall = {
      method: request.method ?? 'GET',
      url,
      path: separator === -1 ? url : url.slice(0, separator),
      query: Object.fromEntries(new URLSearchParams(separator === -1 ? '' : url.slice(separator + 1))),
      headers: request.headers,
      rawHeaders: [...request.rawHeaders],
      body: Buffer.concat(chunks)
    };
    this.calls.push(call);

    const stub = this.stubs.length === 0 ? { status: 200, body: {} } : this.stubs[Math.min(this.calls.length - 1, this.stubs.length - 1)];
    const resolved: StubResponse = typeof stub === 'function' ? stub(call, this.calls.length - 1) : (stub ?? { status: 200, body: {} });
    const headers: Record<string, string> = { ...resolved.headers };
    let payload: Buffer;
    if (typeof resolved.body === 'string') {
      payload = Buffer.from(resolved.body, 'utf8');
    } else if (resolved.body === undefined) {
      payload = Buffer.alloc(0);
    } else {
      payload = Buffer.from(JSON.stringify(resolved.body), 'utf8');
      headers['content-type'] ??= 'application/json';
    }
    response.writeHead(resolved.status, headers);
    response.end(payload);
  }
}
