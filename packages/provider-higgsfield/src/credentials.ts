/**
 * Provider credential normalization.
 *
 * Higgsfield's dashboard hands out the credential as `<id>:<secret>`, while the API
 * expects the `Authorization: Key <id>:<secret>` header form (docs: "Authorize with
 * `Key <api_key_id>:<api_key_secret>`"). Accepting both means an operator who pastes
 * the dashboard value verbatim gets a working gateway instead of an opaque 401.
 */
export function toAuthorizationValue(credentials: string): string {
  const trimmed = credentials.trim();
  if (/^key\s+\S+:\S+$/i.test(trimmed)) return trimmed;
  // Bare `<id>:<secret>` (optionally already prefixed with a stray `Key`).
  if (/^\S+:\S+$/.test(trimmed)) return `Key ${trimmed}`;
  return trimmed;
}

/** Extracts the API-key id from either credential form, for account binding. */
export function credentialKeyId(credentials: string): string | undefined {
  const match = /^(?:key\s+)?([^:\s]{1,128}):/i.exec(credentials.trim());
  return match?.[1];
}
