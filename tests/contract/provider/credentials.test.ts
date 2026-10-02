import { describe, expect, it } from 'vitest';
import { credentialKeyId, HiggsfieldProvider, toAuthorizationValue } from '@higgsfield-mcp/provider-higgsfield';
import { startHttpDouble } from '../../integration/harness/services.js';

const BARE = 'aa0b57c8-affb-489e-92eb-d86b5ec3cad1:5cec57463d364c1fc6215ce89a6ccc94036207fc598349a4e556fcf08a6afdff';
const PREFIXED = `Key ${BARE}`;

describe('provider credential normalization', () => {
  it('accepts the dashboard form and the documented header form', () => {
    expect(toAuthorizationValue(BARE)).toBe(PREFIXED);
    expect(toAuthorizationValue(PREFIXED)).toBe(PREFIXED);
    expect(toAuthorizationValue('key ' + BARE)).toBe('key ' + BARE);
    expect(toAuthorizationValue('  ' + BARE + '  ')).toBe(PREFIXED);
  });

  it('extracts the account binding from either form', () => {
    expect(credentialKeyId(BARE)).toBe('aa0b57c8-affb-489e-92eb-d86b5ec3cad1');
    expect(credentialKeyId(PREFIXED)).toBe('aa0b57c8-affb-489e-92eb-d86b5ec3cad1');
    expect(credentialKeyId('not-a-credential')).toBeUndefined();
  });

  it('sends the documented `Key <id>:<secret>` header even when given the bare form', async () => {
    const seen: (string | string[] | undefined)[] = [];
    const provider = await startHttpDouble((request) => {
      seen.push(request.headers['authorization']);
      return { status: 200, body: { credits: '0.96', usd: '0.06' } };
    });
    try {
      const client = new HiggsfieldProvider({
        credentials: { credentials: BARE, accountId: 'acct' },
        baseUrl: provider.url
      });
      const estimate = await client.estimateCost({
        endpoint: 'xai/grok-imagine-image-2.0',
        input: { prompt: 'x' }
      });
      expect(estimate.microUsd).toBe(60_000);
      expect(seen).toEqual([PREFIXED]);
    } finally {
      await provider.close();
    }
  });
});
