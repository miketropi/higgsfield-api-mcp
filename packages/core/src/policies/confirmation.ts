import type { Clock, RequestContext } from '../contracts.js';
import { GatewayError } from '../errors.js';
import { newOpaqueToken, sha256Hex } from '../ids.js';
import type { ConfirmationRecord, JobRepository, JobTransaction } from '../jobs/repository.js';

export interface ConfirmationCreateInput {
  tenantId: string;
  tool: string;
  requestHash: string;
  estimatedMicroUsd: number;
}

export interface ConfirmationConsumeInput {
  token: string;
  tenantId: string;
  tool: string;
  requestHash: string;
}

export interface ConfirmationStore {
  readonly ttlMs: number;
  create(input: ConfirmationCreateInput, context: RequestContext): Promise<{ token: string; expiresAt: string }>;
  /**
   * Consumes the token exactly once inside the caller's admission transaction, so
   * a confirmation cannot be replayed even under concurrent requests.
   */
  consumeInTransaction(tx: JobTransaction, input: ConfirmationConsumeInput): Promise<{ estimatedMicroUsd: number }>;
}

export interface ConfirmationStoreOptions {
  repository: JobRepository;
  clock: Clock;
  ttlMs?: number | undefined;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function createConfirmationStore(options: ConfirmationStoreOptions): ConfirmationStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  const reject = (reason: string): never => {
    throw new GatewayError('POLICY_REJECTED', 'The confirmation token is not valid for this request.', {
      details: { reason }
    });
  };

  return {
    ttlMs,

    async create(input) {
      const token = newOpaqueToken(32);
      const tokenHash = sha256Hex(token);
      const now = options.clock.now();
      const record: ConfirmationRecord = {
        tokenHash,
        tenantId: input.tenantId,
        tool: input.tool,
        requestHash: input.requestHash,
        estimatedMicroUsd: input.estimatedMicroUsd,
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        createdAt: now.toISOString()
      };
      await options.repository.transaction(async (tx) => {
        await tx.putConfirmation(record);
      });
      return { token, expiresAt: record.expiresAt };
    },

    async consumeInTransaction(tx, input) {
      const tokenHash = sha256Hex(input.token);
      const record = await tx.getConfirmation(tokenHash);
      if (record === undefined) return reject('unknown_token');
      if (record.tenantId !== input.tenantId) return reject('wrong_tenant');
      if (record.tool !== input.tool) return reject('wrong_tool');
      if (record.requestHash !== input.requestHash) return reject('request_changed');
      const now = options.clock.now().toISOString();
      if (record.expiresAt <= now) return reject('expired');
      const consumed = await tx.consumeConfirmation(tokenHash, now);
      if (consumed === undefined) return reject('already_used');
      return { estimatedMicroUsd: consumed.estimatedMicroUsd };
    }
  };
}
