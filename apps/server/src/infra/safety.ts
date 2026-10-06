/**
 * Checks on text that a model wrote and a later model will be shown as part of
 * its instructions — a memory entry, a skill an agent taught itself. Such text
 * must not carry instructions aimed at the reader, or anyone's credentials.
 */
const INVISIBLE = /[\u200b-\u200d\u202a-\u202e\u2066-\u2069\ufeff]/;
const THREATS = [
  /ignore (all )?previous instructions/i,
  /\byou are now\b/i,
  /disregard (the )?(above|system)/i,
  /curl[^\n]*\$(\w*)(KEY|TOKEN|SECRET)/i,
  /cat\s+[^\n]*\.env/i,
  /~\/\.ssh|authorized_keys/i,
];

/** Why this text may not be stored or shown to a model, if there is a reason. */
export function unsafeReason(content: string): "invisible" | "threat" | null {
  if (INVISIBLE.test(content)) return "invisible";
  return THREATS.some((pattern) => pattern.test(content)) ? "threat" : null;
}

const SECRETS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\b(api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi,
];

export const redactSecrets = (text: string): string =>
  SECRETS.reduce((out, pattern) => out.replace(pattern, "[REDACTED_SECRET]"), text);
