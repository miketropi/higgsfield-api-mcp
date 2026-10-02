import type { AuthInfo } from '@modelcontextprotocol/server';
import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  verifyBearerToken
} from '@modelcontextprotocol/server';
import type { AuthContext, LoggerPort, RequestContext, Scope } from '@higgsfield-mcp/core';
import { digestEquals, GatewayError, newId, SCOPES, sha256Hex } from '@higgsfield-mcp/core';
import type { GatewayConfig, TenantRecord } from '@higgsfield-mcp/config';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface AuthResult {
  auth: AuthContext;
  authInfo: AuthInfo;
}

export interface AuthService {
  /** HTTP: authenticates a bearer token or throws a GatewayError. */
  authenticateHttp(authorizationHeader: string | undefined): Promise<AuthResult>;
  /** stdio: the implicit local tenant. */
  localContext(): AuthContext;
  /** Operator-only bearer token for /metrics. */
  metricsAuthorized(authorizationHeader: string | undefined): boolean;
  /** RFC 9728 protected-resource metadata document, when the deployment serves one. */
  protectedResourceMetadata(): Record<string, unknown> | undefined;
  resourceMetadataUrl(): string | undefined;
  challengeResponse(error: unknown, requiredScopes?: string[]): Response;
}

export interface AuthServiceOptions {
  config: GatewayConfig;
  env: Record<string, string | undefined>;
  tenants: readonly TenantRecord[];
  logger: LoggerPort;
  now?: (() => Date) | undefined;
}

const ALL_SCOPES: string[] = [SCOPES.read, SCOPES.generate, SCOPES.upload];

export function createAuthService(options: AuthServiceOptions): AuthService {
  const now = options.now ?? (() => new Date());
  const publicUrl = options.config.server.publicUrl;
  const resourceMetadataUrl =
    publicUrl === undefined ? undefined : getOAuthProtectedResourceMetadataUrl(new URL(publicUrl));
  const byTokenDigest = new Map(
    options.tenants
      .filter((tenant) => tenant.tokenSha256 !== undefined)
      .map((tenant) => [(tenant.tokenSha256 as string).toLowerCase(), tenant])
  );
  const bySubject = new Map(
    options.tenants
      .filter((tenant) => tenant.oauthSubject !== undefined)
      .map((tenant) => [tenant.oauthSubject as string, tenant])
  );
  const oauth = options.config.auth.oauth;
  const jwks = oauth === undefined ? undefined : createRemoteJWKSet(new URL(oauth.jwksUrl));

  const toAuthContext = (tenant: TenantRecord | undefined, mode: AuthContext['mode'], subject?: string): AuthContext => {
    if (tenant === undefined) {
      throw new GatewayError('AUTHENTICATION_FAILED', 'No tenant is provisioned for this credential.');
    }
    const context: AuthContext = { tenantId: tenant.tenantId, mode, scopes: tenant.scopes, tokenId: tenant.tokenId };
    if (subject !== undefined) context.subject = subject;
    return context;
  };

  const verifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const digest = sha256Hex(token);
      const tenant = [...byTokenDigest.entries()].find(([expected]) => digestEquals(expected, digest))?.[1];
      if (tenant === undefined) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'The bearer token is not recognized.');
      }
      const timestamp = now().toISOString();
      if (tenant.expiresAt <= timestamp) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'The bearer token has expired.');
      }
      if (publicUrl !== undefined && tenant.audience !== publicUrl) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'The bearer token audience does not match this gateway.');
      }
      const info: AuthInfo = {
        token,
        clientId: tenant.tokenId,
        scopes: [...tenant.scopes],
        expiresAt: Math.floor(Date.parse(tenant.expiresAt) / 1000)
      };
      if (resourceMetadataUrl !== undefined) info.resourceMetadataUrl = resourceMetadataUrl;
      return info;
    }
  };

  const verifyJwt = async (token: string): Promise<AuthInfo> => {
    if (oauth === undefined || jwks === undefined) {
      throw new GatewayError('AUTHENTICATION_FAILED', 'OAuth JWT authentication is not configured.');
    }
    let subject: string;
    let exp: number | undefined;
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: oauth.issuer, audience: oauth.audience });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token has no subject claim.');
      }
      subject = payload.sub;
      exp = typeof payload.exp === 'number' ? payload.exp : undefined;
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token failed verification.');
    }
    const tenant = bySubject.get(subject);
    if (tenant === undefined) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'The token subject is not mapped to a tenant.');
    }
    const info: AuthInfo = {
      token,
      clientId: tenant.tokenId,
      scopes: [...tenant.scopes],
      ...(exp === undefined ? {} : { expiresAt: exp })
    };
    if (resourceMetadataUrl !== undefined) info.resourceMetadataUrl = resourceMetadataUrl;
    return info;
  };

  const authenticateHttp = async (authorizationHeader: string | undefined): Promise<AuthResult> => {
    const mode = options.config.auth.mode;
    if (mode === 'none') {
      throw new GatewayError('AUTHENTICATION_FAILED', 'This gateway does not accept HTTP requests without auth.');
    }
    const active = mode === 'oauth_jwt' ? { verifyAccessToken: verifyJwt } : verifier;
    const authInfo = await verifyBearerToken(authorizationHeader, {
      verifier: active,
      ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl })
    });
    if (authInfo.expiresAt !== undefined && authInfo.expiresAt <= Math.floor(now().getTime() / 1000)) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'The bearer token has expired.');
    }
    const tenant = options.tenants.find((candidate) => candidate.tokenId === authInfo.clientId);
    const auth = toAuthContext(tenant, mode === 'oauth_jwt' ? 'oauth_jwt' : 'static_token', tenant?.oauthSubject);
    // The verified gateway context travels with the SDK AuthInfo (pass-through) so the
    // per-request MCP factory can build a tool context without any ambient state.
    authInfo.extra = { ...(authInfo.extra ?? {}), gateway: { ...auth } };
    return { auth, authInfo };
  };

  return {
    authenticateHttp,

    localContext() {
      return { tenantId: 'local', mode: 'stdio', scopes: [...ALL_SCOPES], tokenId: 'stdio-local' };
    },

    metricsAuthorized(authorizationHeader) {
      const token = options.config.auth.metricsToken;
      if (token === undefined || token.length === 0) return false;
      if (authorizationHeader === undefined) return false;
      const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
      if (match?.[1] === undefined) return false;
      return digestEquals(sha256Hex(match[1]), sha256Hex(token));
    },

    protectedResourceMetadata() {
      if (publicUrl === undefined) return undefined;
      const document: Record<string, unknown> = {
        resource: publicUrl,
        bearer_methods_supported: ['header'],
        scopes_supported: ALL_SCOPES
      };
      if (options.config.auth.mode === 'oauth_jwt' && oauth !== undefined) {
        document['authorization_servers'] = [oauth.issuer];
      }
      return document;
    },

    resourceMetadataUrl() {
      return resourceMetadataUrl;
    },

    challengeResponse(error, requiredScopes) {
      return bearerAuthChallengeResponse(error, {
        ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
        ...(requiredScopes === undefined ? {} : { requiredScopes })
      });
    }
  };
}

/** Builds the per-request context for one authenticated HTTP call. */
export function httpRequestContext(auth: AuthContext, workspaceId?: string): RequestContext {
  const context: RequestContext = {
    requestId: newId('req'),
    tenantId: auth.tenantId,
    transport: 'http',
    auth
  };
  if (workspaceId !== undefined) context.workspaceId = workspaceId;
  return context;
}

export function scopesSatisfied(auth: AuthContext | undefined, scope: Scope): boolean {
  if (auth === undefined) return true;
  return auth.scopes.includes(scope);
}
