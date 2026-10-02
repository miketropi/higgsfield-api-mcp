import type { AuthContext, LoggerPort, MetricsPort, RequestContext } from '@higgsfield-mcp/core';
import { GatewayError } from '@higgsfield-mcp/core';
import type { GatewayConfig } from '@higgsfield-mcp/config';
import type { McpToolDependencies } from '@higgsfield-mcp/mcp';
import { createGatewayMcpServer } from '@higgsfield-mcp/mcp';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AuthService } from '../auth.js';
import { GATEWAY_VERSION } from '../version.js';
import type { WebhookRequest, WebhookResponse } from '../webhooks/higgsfield.js';

/** Structural view of the observability metrics object; keeps this layer decoupled. */
export interface RenderableMetrics extends MetricsPort {
  render(): Promise<string>;
  readonly contentType: string;
}

export interface HttpServerOptions {
  config: GatewayConfig;
  deps: McpToolDependencies;
  auth: AuthService;
  logger: LoggerPort;
  metrics: RenderableMetrics;
  webhook: (request: WebhookRequest) => Promise<WebhookResponse>;
  readiness: () => Promise<{ ok: boolean; checks: Record<string, boolean> }>;
  contextFor: (auth: AuthContext, workspaceId?: string) => RequestContext;
}

export interface HttpServerHandle {
  close: () => Promise<void>;
  app: FastifyInstance;
  /** Stops admitting new MCP work while in-flight requests drain. */
  stopAdmission: () => void;
}

const WEBHOOK_BODY_LIMIT = 64 * 1024;

function hostnames(origins: readonly string[]): string[] {
  return origins.map((origin) => {
    try {
      return new URL(origin).hostname;
    } catch {
      return origin;
    }
  });
}

export async function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const { config } = options;
  const bodyLimit = config.server.bodyLimitBytes;
  let admitting = true;

  const app = Fastify({
    logger: false,
    bodyLimit,
    trustProxy: false
  });

  const handler = createMcpHandler(
    (ctx) => {
      const gateway = ctx.authInfo?.extra?.['gateway'] as AuthContext | undefined;
      if (gateway === undefined) {
        throw new GatewayError('AUTHENTICATION_FAILED', 'HTTP requests must carry a verified tenant binding.');
      }
      return createGatewayMcpServer(options.deps, options.contextFor(gateway));
    },
    {
      legacy: 'stateless',
      responseMode: 'auto',
      maxRequestBodySize: bodyLimit,
      onerror: (error: Error) => {
        options.logger.error({ event: 'mcp.handler_error', err: error.name }, 'MCP handler error');
      }
    }
  );

  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: bodyLimit });

  const validateHost = hostHeaderValidation(config.server.allowedHosts);
  const validateOrigin = originValidation(hostnames(config.server.allowedOrigins));

  app.addHook('onRequest', async (request, reply) => {
    await validateHost(request, reply);
    if (reply.sent) return;
    await validateOrigin(request, reply);
  });

  const sendChallenge = async (reply: FastifyReply, error: unknown): Promise<void> => {
    const response = options.auth.challengeResponse(error);
    reply.code(response.status);
    response.headers.forEach((value, key) => {
      void reply.header(key, value);
    });
    reply.send(await response.text());
  };

  app.all('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!admitting) {
      reply.code(503).header('retry-after', '5');
      reply.send(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Gateway is shutting down.' } }));
      return;
    }
    let authInfo: unknown;
    try {
      const result = await options.auth.authenticateHttp(request.headers.authorization);
      authInfo = result.authInfo;
    } catch (error) {
      await sendChallenge(reply, error);
      return;
    }
    const requestId = request.id;
    options.logger.debug(
      { event: 'http.mcp_request', method: request.method, request_id: requestId },
      'Serving MCP request'
    );
    reply.hijack();
    type NodeRequest = Parameters<typeof nodeHandler>[0];
    await nodeHandler(Object.assign(request.raw, { auth: authInfo }) as NodeRequest, reply.raw, request.body);
  });

  app.get('/health', async () => ({ status: 'ok', version: GATEWAY_VERSION, uptime_s: process.uptime() }));

  app.get('/ready', async (_request, reply) => {
    const result = await options.readiness();
    reply.code(result.ok ? 200 : 503);
    return { status: result.ok ? 'ready' : 'not_ready', checks: result.checks };
  });

  app.get('/metrics', async (request, reply) => {
    if (!options.auth.metricsAuthorized(request.headers.authorization)) {
      reply.code(401).header('www-authenticate', 'Bearer realm="metrics"');
      return { error: { code: 'AUTHENTICATION_FAILED', message: 'A metrics bearer token is required.' } };
    }
    const body = await options.metrics.render();
    reply.type(options.metrics.contentType);
    return body;
  });

  app.post('/webhooks/higgsfield', { bodyLimit: WEBHOOK_BODY_LIMIT }, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const response = await options.webhook({
      method: request.method,
      query,
      headers: request.headers as Record<string, string | undefined>,
      body: request.body
    });
    reply.code(response.status);
    for (const [key, value] of Object.entries(response.headers ?? {})) void reply.header(key, value);
    if (response.status === 202) return null;
    return response.body ?? null;
  });

  const metadata = options.auth.protectedResourceMetadata();
  if (metadata !== undefined) {
    const serveMetadata = async (reply: FastifyReply): Promise<Record<string, unknown>> => {
      reply.type('application/json');
      return metadata;
    };
    app.get('/.well-known/oauth-protected-resource', (_request, reply) => serveMetadata(reply));
    app.get('/.well-known/oauth-protected-resource/*', (_request, reply) => serveMetadata(reply));
  }

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404);
    return { error: { code: 'JOB_NOT_FOUND', message: 'Not found.' } };
  });

  await app.listen({ host: config.server.host, port: config.server.port });
  options.logger.info(
    { event: 'transport.ready', transport: 'http', host: config.server.host, port: config.server.port },
    'MCP gateway listening'
  );

  return {
    app,
    stopAdmission() {
      admitting = false;
    },
    async close() {
      admitting = false;
      await app.close();
      await handler.close();
    }
  };
}
