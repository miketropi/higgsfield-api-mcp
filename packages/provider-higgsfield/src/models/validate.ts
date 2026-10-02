/**
 * JSON Schema (subset) validation for documented model input schemas.
 *
 * The catalog stores the provider's own JSON Schema verbatim; validating a
 * request against it before the first POST catches a rejected parameter without
 * spending a provider round trip (or credits). Only the keywords the documented
 * schemas actually use are implemented — anything else is ignored, so a schema
 * addition can never silently change adapter behaviour.
 *
 * Issues carry the failing JSON pointer and keyword but never the offending
 * value: issue lists are surfaced to callers.
 */
import { GatewayError } from '@higgsfield-mcp/core';

export interface SchemaValidationIssue {
  pointer: string;
  keyword: string;
  message: string;
}

const MAX_VALIDATION_DEPTH = 16;
const MAX_PATH_SEGMENT_ECHO = 64;

const URI_FORMAT = 'uri';

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'object':
      return 'object';
    default:
      return typeof value;
  }
}

function matchesType(expected: string, value: unknown): boolean {
  const actual = jsonTypeOf(value);
  if (expected === actual) return true;
  return expected === 'number' && actual === 'integer';
}

function display(value: unknown, maxLength = 60): string {
  const text = typeof value === 'string' ? `"${value}"` : JSON.stringify(value) ?? String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * True when `value` is a non-null, non-array object. The single narrowing point
 * for every undocumented JSON shape handled here.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Resolves a local (`#/...`) JSON pointer against the root schema. */
function resolveRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return isRecord(current) ? current : undefined;
}

function validateNode(
  root: Record<string, unknown>,
  schema: Record<string, unknown>,
  value: unknown,
  pointer: string,
  issues: SchemaValidationIssue[],
  depth: number
): void {
  if (depth > MAX_VALIDATION_DEPTH || issues.length >= 20) return;

  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const resolved = resolveRef(root, ref);
    if (resolved === undefined) {
      issues.push({ pointer, keyword: '$ref', message: `Unresolved schema reference ${display(ref)}.` });
      return;
    }
    validateNode(root, resolved, value, pointer, issues, depth + 1);
    return;
  }

  const expectedType = schema['type'];
  if (typeof expectedType === 'string' && !matchesType(expectedType, value)) {
    issues.push({ pointer, keyword: 'type', message: `Must be of type ${expectedType}.` });
    return;
  }

  const allowed = schema['enum'];
  if (Array.isArray(allowed) && !allowed.some((candidate) => candidate === value)) {
    issues.push({ pointer, keyword: 'enum', message: `Must be one of ${allowed.map((item) => display(item)).join(', ')}.` });
    return;
  }

  if (Object.hasOwn(schema, 'const') && schema['const'] !== value) {
    issues.push({ pointer, keyword: 'const', message: `Must equal ${display(schema['const'])}.` });
    return;
  }

  if (typeof value === 'string') {
    const minLength = schema['minLength'];
    if (typeof minLength === 'number' && value.length < minLength) {
      issues.push({ pointer, keyword: 'minLength', message: `Must be at least ${minLength} characters.` });
    }
    const maxLength = schema['maxLength'];
    if (typeof maxLength === 'number' && value.length > maxLength) {
      issues.push({ pointer, keyword: 'maxLength', message: `Must be at most ${maxLength} characters.` });
    }
    if (schema['format'] === URI_FORMAT) {
      let valid = false;
      try {
        valid = new URL(value).protocol.length > 0;
      } catch {
        valid = false;
      }
      if (!valid) issues.push({ pointer, keyword: 'format', message: 'Must be an absolute URI.' });
    }
  }

  if (typeof value === 'number') {
    const minimum = schema['minimum'];
    if (typeof minimum === 'number' && value < minimum) {
      issues.push({ pointer, keyword: 'minimum', message: `Must be greater than or equal to ${minimum}.` });
    }
    const maximum = schema['maximum'];
    if (typeof maximum === 'number' && value > maximum) {
      issues.push({ pointer, keyword: 'maximum', message: `Must be less than or equal to ${maximum}.` });
    }
    const multipleOf = schema['multipleOf'];
    if (typeof multipleOf === 'number' && multipleOf > 0) {
      const quotient = value / multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        issues.push({ pointer, keyword: 'multipleOf', message: `Must be a multiple of ${multipleOf}.` });
      }
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema['minItems'];
    if (typeof minItems === 'number' && value.length < minItems) {
      issues.push({ pointer, keyword: 'minItems', message: `Must contain at least ${minItems} items.` });
    }
    const maxItems = schema['maxItems'];
    if (typeof maxItems === 'number' && value.length > maxItems) {
      issues.push({ pointer, keyword: 'maxItems', message: `Must contain at most ${maxItems} items.` });
    }
    const items = schema['items'];
    if (isRecord(items)) {
      value.forEach((item, index) => {
        validateNode(root, items, item, `${pointer}/${index}`, issues, depth + 1);
      });
    }
  }

  if (isRecord(value)) {
    const record = value;
    const properties = isRecord(schema['properties']) ? schema['properties'] : {};
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !Object.hasOwn(record, key)) {
          issues.push({
            pointer: `${pointer}/${key.slice(0, MAX_PATH_SEGMENT_ECHO)}`,
            keyword: 'required',
            message: 'Is required.'
          });
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(record, key)) continue;
      if (!isRecord(propertySchema)) continue;
      validateNode(root, propertySchema, record[key], `${pointer}/${key}`, issues, depth + 1);
    }
    if (schema['additionalProperties'] === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) {
          issues.push({
            pointer,
            keyword: 'additionalProperties',
            message: `Property ${display(key, MAX_PATH_SEGMENT_ECHO)} is not supported by this endpoint.`
          });
        }
      }
    }
  }

  const ifSchema = schema['if'];
  if (isRecord(ifSchema)) {
    const branchIssues: SchemaValidationIssue[] = [];
    validateNode(root, ifSchema, value, pointer, branchIssues, depth + 1);
    const branch = branchIssues.length === 0 ? schema['then'] : schema['else'];
    if (isRecord(branch)) {
      validateNode(root, branch, value, pointer, issues, depth + 1);
    }
  }
}

/** Validates `value` against a documented JSON Schema; empty result means valid. */
export function validateAgainstJsonSchema(
  schema: Record<string, unknown>,
  value: unknown
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  validateNode(schema, schema, value, '', issues, 0);
  return issues;
}

/**
 * Deep-copies a JSON value, rejecting anything that is not JSON (`undefined`,
 * functions, symbols, `bigint`, `Date`, class instances, cycles). This is what
 * makes `prepare()` body construction deterministic: the persisted body contains
 * only JSON scalars, arrays and plain objects.
 */
export function cloneJsonValue(value: unknown, pointer = '', depth = 0): unknown {
  if (depth > MAX_VALIDATION_DEPTH) {
    throw new GatewayError('INVALID_INPUT', 'Provider input is nested too deeply.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GatewayError('INVALID_INPUT', `Provider input at ${pointer || '/'} is not a finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneJsonValue(item, `${pointer}/${index}`, depth + 1));
  }
  if (isRecord(value)) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new GatewayError('INVALID_INPUT', `Provider input at ${pointer || '/'} is not a plain JSON object.`);
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new GatewayError('INVALID_INPUT', 'Provider input contains an unsafe property name.');
      }
      const item = value[key];
      // `undefined` means "absent" in JSON; dropping it keeps bodies byte-stable.
      if (item === undefined) continue;
      output[key] = cloneJsonValue(item, `${pointer}/${key}`, depth + 1);
    }
    return output;
  }
  throw new GatewayError('INVALID_INPUT', `Provider input at ${pointer || '/'} is not a JSON value.`);
}
