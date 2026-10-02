import type { CredentialResolver, LoggerPort, ProviderCredentials, RequestContext } from '@higgsfield-mcp/core';
import { GatewayError } from '@higgsfield-mcp/core';
import type { GatewayConfig, TenantRecord } from '@higgsfield-mcp/config';

/**
 * Extracts the stable account binding from a `Key <id>:<secret>` credential string.
 * Used only in local mode, where the operator did not configure an explicit account id.
 */
export function accountIdFromCredential(credentials: string): string {
  // Accepts both the dashboard `<id>:<secret>` form and `Key <id>:<secret>`.
  const match = /^(?:key\s+)?([^:\s]{1,128}):/.exec(credentials.trim());
  if (match?.[1] !== undefined) return match[1];
  return 'default';
}

export interface CredentialResolverOptions {
  config: GatewayConfig;
  env: Record<string, string | undefined>;
  tenants: readonly TenantRecord[];
  logger: LoggerPort;
}

/**
 * Resolves provider credentials per request. Never returns global mutable state and
 * never places credential material on a job, asset, log line, or MCP response.
 */
export function createCredentialResolver(options: CredentialResolverOptions): CredentialResolver {
  const byTenant = new Map(options.tenants.map((tenant) => [tenant.tenantId, tenant]));

  return {
    async resolve(context: RequestContext): Promise<ProviderCredentials> {
      const tenantId = context.tenantId;
      if (options.config.mode === 'local') {
        const credentials = options.config.provider.credentials;
        if (credentials === undefined || credentials.length === 0) {
          throw new GatewayError(
            'AUTHENTICATION_FAILED',
            'No Higgsfield API credentials are configured. Set HF_API_CREDENTIALS.',
            { details: { env: 'HF_API_CREDENTIALS' } }
          );
        }
        return {
          credentials,
          accountId: options.config.provider.accountId ?? accountIdFromCredential(credentials)
        };
      }
      if (tenantId === undefined) {
        throw new GatewayError('AUTHENTICATION_FAILED', 'Request context carries no tenant binding.');
      }
      const tenant = byTenant.get(tenantId);
      if (tenant === undefined) {
        throw new GatewayError('AUTHENTICATION_FAILED', 'Tenant is not provisioned for provider access.', {
          details: { tenant_id: tenantId }
        });
      }
      const credentials = options.env[tenant.providerCredentialsEnv];
      if (credentials === undefined || credentials.length === 0) {
        options.logger.error(
          { event: 'provider.credentials_missing', tenant_id: tenantId, env: tenant.providerCredentialsEnv },
          'Tenant references a provider credential environment variable that is not set'
        );
        throw new GatewayError('AUTHENTICATION_FAILED', 'Provider credentials are not available for this tenant.', {
          details: { tenant_id: tenantId }
        });
      }
      return { credentials, accountId: tenant.providerAccountId };
    }
  };
}
