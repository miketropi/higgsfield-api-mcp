import type { ModelDefinition, ModelFilter, ModelRegistry, PricingDefinition } from '../contracts.js';
import { GatewayError } from '../errors.js';

export interface PricingOverride {
  unitMicroUsd?: number | undefined;
  perSecondMicroUsd?: number | undefined;
  source?: string | undefined;
  asOf?: string | undefined;
}

export interface ModelRegistryOptions {
  models: readonly ModelDefinition[];
  aliases?: Record<string, string> | undefined;
  pricing?: Record<string, PricingOverride> | undefined;
  today?: (() => string) | undefined;
}

function withPricing(model: ModelDefinition, override: PricingOverride | undefined, today: string): ModelDefinition {
  if (override === undefined) return model;
  const pricing: PricingDefinition = {
    currency: 'USD',
    source: override.source ?? 'operator_override',
    asOf: override.asOf ?? today
  };
  if (override.unitMicroUsd !== undefined) pricing.unitMicroUsd = override.unitMicroUsd;
  if (override.perSecondMicroUsd !== undefined) pricing.perSecondMicroUsd = override.perSecondMicroUsd;
  return { ...model, pricing };
}

/**
 * Central model resolution (SPEC §19, §20). Aliases and price overrides come from
 * operator configuration; the catalog itself comes from the provider adapter.
 */
export function createModelRegistry(options: ModelRegistryOptions): ModelRegistry {
  const today = options.today?.() ?? new Date().toISOString().slice(0, 10);
  const aliases = { ...(options.aliases ?? {}) };
  const byId = new Map<string, ModelDefinition>();
  for (const model of options.models) {
    if (byId.has(model.id)) {
      throw new GatewayError('INTERNAL_ERROR', `Duplicate model id in catalog: ${model.id}.`);
    }
    byId.set(model.id, withPricing(model, options.pricing?.[model.id], today));
  }
  for (const [alias, target] of Object.entries(aliases)) {
    if (!byId.has(target)) {
      throw new GatewayError('INTERNAL_ERROR', `Model alias ${alias} points to unknown model ${target}.`, {
        details: { alias, target }
      });
    }
  }
  const resolveAlias = (alias: string): ModelDefinition | undefined => {
    const target = aliases[alias];
    return target === undefined ? undefined : byId.get(target);
  };

  return {
    list(filter?: ModelFilter) {
      return [...byId.values()]
        .filter((model) => filter?.type === undefined || model.type === filter.type)
        .filter((model) => filter?.capability === undefined || model.capabilities.includes(filter.capability))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
    },

    get(id: string) {
      const model = byId.get(id);
      if (model === undefined) {
        throw new GatewayError('MODEL_NOT_FOUND', `Unknown model: ${id}.`, { details: { model: id } });
      }
      return model;
    },

    resolve(idOrAlias: string, capability: string) {
      const aliased = resolveAlias(idOrAlias);
      if (aliased !== undefined) {
        if (!aliased.capabilities.includes(capability)) {
          throw new GatewayError('MODEL_UNAVAILABLE', `Model alias ${idOrAlias} cannot perform ${capability}.`, {
            details: { alias: idOrAlias, model: aliased.id, capability }
          });
        }
        return aliased;
      }
      const explicit = byId.get(idOrAlias);
      if (explicit === undefined) {
        throw new GatewayError('MODEL_NOT_FOUND', `Unknown model: ${idOrAlias}.`, { details: { model: idOrAlias } });
      }
      if (!explicit.capabilities.includes(capability)) {
        throw new GatewayError('INVALID_INPUT', `Model ${idOrAlias} does not support ${capability}.`, {
          details: { model: explicit.id, capability, supported: explicit.capabilities }
        });
      }
      return explicit;
    },

    aliases() {
      return { ...aliases };
    }
  };
}
