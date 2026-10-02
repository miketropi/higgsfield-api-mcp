/** A single configuration problem. `path` is the dotted config path, e.g. `server.port`. */
export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Renders a Zod issue path with bracket notation for array indices, e.g.
 * `tenants[0].tokenSha256`. An empty path (a root-level object) becomes
 * `(root)`.
 */
export function formatIssuePath(path: readonly (string | number | symbol)[]): string {
  let rendered = '';
  for (const segment of path) {
    if (typeof segment === 'number') rendered += `[${segment}]`;
    else if (rendered === '') rendered = String(segment);
    else rendered += `.${String(segment)}`;
  }
  return rendered === '' ? '(root)' : rendered;
}

const MAX_REPORTED_ISSUES = 50;

function formatIssues(issues: readonly ConfigIssue[]): string {
  if (issues.length === 0) return 'Invalid configuration';
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => `${issue.path || '(root)'}: ${issue.message}`);
  const suffix = issues.length > MAX_REPORTED_ISSUES ? `; … ${issues.length - MAX_REPORTED_ISSUES} more` : '';
  return `Invalid configuration (${issues.length} issue${issues.length === 1 ? '' : 's'}): ${shown.join('; ')}${suffix}`;
}

/**
 * Thrown for every configuration failure — malformed environment values,
 * unknown CLI flags, unreadable or invalid JSON files, and failed cross-field
 * requirements. `issues` always carries the complete list of problems.
 */
export class ConfigValidationError extends Error {
  readonly issues: { path: string; message: string }[];

  constructor(issues: readonly ConfigIssue[]) {
    super(formatIssues(issues));
    this.name = 'ConfigValidationError';
    this.issues = issues.map((issue) => ({ path: issue.path, message: issue.message }));
  }
}
