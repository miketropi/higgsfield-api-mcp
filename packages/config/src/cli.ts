import { ConfigValidationError, type ConfigIssue } from './errors.js';
import { TRANSPORT_MODES } from './defaults.js';
import { parseEnumValue, parseIntValue, parseNonEmptyValue, parseOk, type ParseResult } from './parse.js';
import type { TransportMode } from './types.js';

/**
 * Explicit typed overrides. Structurally identical to the supported
 * command-line flags; they always win over parsed argv.
 */
export interface CliOverrides {
  config?: string;
  transport?: TransportMode;
  host?: string;
  port?: number;
}

export interface ParsedGlobalFlags {
  /** Non-flag arguments, in order (e.g. the `serve` subcommand). */
  positionals: string[];
  flags: CliOverrides;
}

/** The only flags the global reader consumes; anything else is fatal. */
export const CLI_FLAG_NAMES = ['--config', '--transport', '--host', '--port'] as const;
type CliFlagName = (typeof CLI_FLAG_NAMES)[number];

const CLI_FLAG_SET: Record<string, true> = { '--config': true, '--transport': true, '--host': true, '--port': true };

function isFlagName(token: string): token is CliFlagName {
  return CLI_FLAG_SET[token] === true;
}

type FlagHandler = (value: string, flags: CliOverrides) => ParseResult<void>;

function assign<K extends keyof CliOverrides>(parsed: ParseResult<CliOverrides[K]>, flags: CliOverrides, key: K): ParseResult<void> {
  if (!parsed.ok) return parsed;
  flags[key] = parsed.value;
  return parseOk(undefined);
}

const FLAG_HANDLERS: Record<CliFlagName, FlagHandler> = {
  '--config': (value, flags) => assign(parseNonEmptyValue(value), flags, 'config'),
  '--transport': (value, flags) => assign(parseEnumValue(value, TRANSPORT_MODES), flags, 'transport'),
  '--host': (value, flags) => assign(parseNonEmptyValue(value), flags, 'host'),
  '--port': (value, flags) => assign(parseIntValue(value, { min: 1, max: 65_535 }), flags, 'port')
};

/**
 * Splits argv into positionals and the global flags this package understands.
 *
 * Supported forms: `--flag value` and `--flag=value`. A bare `--` terminates
 * flag parsing. Unknown flags, missing values, and malformed values are fatal;
 * every problem is collected before throwing so one run reports them all.
 * Repeating a flag is allowed and the last occurrence wins.
 */
export function parseGlobalFlags(argv: readonly string[]): ParsedGlobalFlags {
  const positionals: string[] = [];
  const flags: CliOverrides = {};
  const issues: ConfigIssue[] = [];
  let index = 0;

  while (index < argv.length) {
    const token = argv[index];
    index += 1;
    if (token === undefined) break;
    if (token === '--') {
      positionals.push(...argv.slice(index));
      break;
    }
    if (token === '-' || !token.startsWith('-')) {
      positionals.push(token);
      continue;
    }

    const separator = token.indexOf('=');
    const name = separator === -1 ? token : token.slice(0, separator);
    if (!isFlagName(name)) {
      issues.push({ path: `cli.${name}`, message: 'unknown flag' });
      continue;
    }

    let value: string;
    if (separator !== -1) {
      value = token.slice(separator + 1);
    } else {
      const next = argv[index];
      if (next === undefined) {
        issues.push({ path: `cli.${name}`, message: 'expected a value' });
        continue;
      }
      value = next;
      index += 1;
    }

    const assigned = FLAG_HANDLERS[name](value, flags);
    if (!assigned.ok) issues.push({ path: `cli.${name}`, message: assigned.message });
  }

  if (issues.length > 0) throw new ConfigValidationError(issues);
  return { positionals, flags };
}
