import { describe, expect, it } from 'vitest';
import { loadTenantsFile } from '@higgsfield-mcp/config';
import { expectIssues, makeTempDir, writeJsonFile } from './helpers.js';

const DIGEST = 'a'.repeat(64);

function tokenRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: 'tenant-1',
    tokenId: 'token-1',
    tokenSha256: DIGEST,
    expiresAt: '2030-01-01T00:00:00.000Z',
    audience: 'https://gateway.example.com',
    scopes: ['generate_image'],
    providerCredentialsEnv: 'HF_TENANT_1_CREDENTIALS',
    providerAccountId: 'acct-1',
    ...overrides
  };
}

function tenantsFile(records: Record<string, unknown>[]): string {
  const dir = makeTempDir();
  return writeJsonFile(dir, 'tenants.json', { tenants: records });
}

describe('loadTenantsFile', () => {
  it('accepts a token-bound record', () => {
    const file = loadTenantsFile(tenantsFile([tokenRecord()]));
    expect(file.tenants).toEqual([
      {
        tenantId: 'tenant-1',
        tokenId: 'token-1',
        tokenSha256: DIGEST,
        expiresAt: '2030-01-01T00:00:00.000Z',
        audience: 'https://gateway.example.com',
        scopes: ['generate_image'],
        providerCredentialsEnv: 'HF_TENANT_1_CREDENTIALS',
        providerAccountId: 'acct-1'
      }
    ]);
  });

  it('accepts an oauth-bound record that carries only a subject', () => {
    const record = tokenRecord({ oauthSubject: 'sub-1' });
    delete record['tokenSha256'];
    const file = loadTenantsFile(tenantsFile([record]));
    expect(file.tenants[0]?.oauthSubject).toBe('sub-1');
    expect(file.tenants[0]?.tokenSha256).toBeUndefined();
    expect(Object.hasOwn(file.tenants[0] ?? {}, 'tokenSha256')).toBe(false);
  });

  it('rejects a record with both bindings', () => {
    expectIssues(() => loadTenantsFile(tenantsFile([tokenRecord({ oauthSubject: 'sub-1' })])), ['tenants[0].tokenSha256']);
  });

  it('rejects a static-token record with neither binding', () => {
    const record = tokenRecord();
    delete record['tokenSha256'];
    expectIssues(() => loadTenantsFile(tenantsFile([record])), ['tenants[0].tokenSha256']);
  });

  it('rejects an empty string digest as a missing binding', () => {
    const emptyDigest = tokenRecord({ tokenSha256: '' });
    const bothEmpty = tokenRecord({ tokenSha256: '', oauthSubject: 'sub-1' });
    expectIssues(() => loadTenantsFile(tenantsFile([emptyDigest])), ['tenants[0].tokenSha256']);
    expect(loadTenantsFile(tenantsFile([bothEmpty])).tenants[0]?.oauthSubject).toBe('sub-1');
  });

  it('rejects a digest that is not a lowercase 64-character hex string', () => {
    expectIssues(() => loadTenantsFile(tenantsFile([tokenRecord({ tokenSha256: 'abc' })])), ['tenants[0].tokenSha256']);
    expectIssues(() => loadTenantsFile(tenantsFile([tokenRecord({ tokenSha256: DIGEST.toUpperCase() })])), ['tenants[0].tokenSha256']);
  });

  it('rejects a credential value stored in providerCredentialsEnv', () => {
    expectIssues(() => loadTenantsFile(tenantsFile([tokenRecord({ providerCredentialsEnv: 'Key abc123:secret' })])), [
      'tenants[0].providerCredentialsEnv'
    ]);
    expectIssues(() => loadTenantsFile(tenantsFile([tokenRecord({ providerCredentialsEnv: 'HF CREDS' })])), [
      'tenants[0].providerCredentialsEnv'
    ]);
    expectIssues(() => loadTenantsFile(tenantsFile([tokenRecord({ providerCredentialsEnv: `HF_${'A'.repeat(70)}` })])), [
      'tenants[0].providerCredentialsEnv'
    ]);
    expectIssues(() => loadTenantsFile(tenantsFile([tokenRecord({ providerCredentialsEnv: 'lower_case' })])), [
      'tenants[0].providerCredentialsEnv'
    ]);
  });

  it('rejects duplicate tenant and token identifiers', () => {
    const duplicateTenant = tenantsFile([tokenRecord(), tokenRecord({ tokenId: 'token-2' })]);
    const duplicateToken = tenantsFile([tokenRecord(), tokenRecord({ tenantId: 'tenant-2' })]);
    expectIssues(() => loadTenantsFile(duplicateTenant), ['tenants[1].tenantId']);
    expectIssues(() => loadTenantsFile(duplicateToken), ['tenants[1].tokenId']);
  });

  it('rejects a non-https audience and a malformed expiry', () => {
    expectIssues(() => loadTenantsFile(tenantsFile([tokenRecord({ audience: 'http://gateway.example.com' })])), [
      'tenants[0].audience'
    ]);
    expectIssues(() => loadTenantsFile(tenantsFile([tokenRecord({ expiresAt: '2030-01-01' })])), ['tenants[0].expiresAt']);
  });

  it('rejects empty or duplicated scopes', () => {
    expectIssues(() => loadTenantsFile(tenantsFile([tokenRecord({ scopes: [] })])), ['tenants[0].scopes']);
    expectIssues(() => loadTenantsFile(tenantsFile([tokenRecord({ scopes: ['generate_image', 'generate_image'] })])), [
      'tenants[0].scopes'
    ]);
  });

  it('rejects unknown keys in the file', () => {
    const dir = makeTempDir();
    const path = writeJsonFile(dir, 'tenants.json', { tenants: [], extra: true });
    expectIssues(() => loadTenantsFile(path), ['(root)']);
  });

  it('allows an empty tenant list', () => {
    expect(loadTenantsFile(tenantsFile([])).tenants).toEqual([]);
  });
});
