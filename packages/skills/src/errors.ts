/** Operator-facing failure: a broken pin, a stale patch, or unusable upstream input. Never a bug in this package. */
export class SkillsError extends Error {
  override readonly name = 'SkillsError';
}
