/**
 * Agent slugs: the machine handle an agent is addressed by (URLs, @mentions,
 * dispatch). Members only ever type a display name; the slug is derived here.
 *
 * Slugs are ASCII — they travel as path segments and header values. Letters,
 * digits and `-` are kept (case preserved), whitespace and `_` become `-`,
 * accented Latin folds to its base letter, everything else is dropped. A name
 * with nothing left falls back to `agent`, suffixed with a short digest when
 * the name held non-ASCII text, so distinct Chinese names get distinct slugs.
 */
import { createHash } from "node:crypto";

export const MAX_SLUG_LENGTH = 120;
const VALID = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export const isValidSlug = (slug: string): boolean => slug.length <= MAX_SLUG_LENGTH && VALID.test(slug);

export function deriveSlug(name: string): string {
  const raw = name.trim();
  const folded = raw.normalize("NFKD").replace(/\p{M}/gu, "");
  const kept = folded
    .replace(/[\s_]+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (kept) return kept.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
  // eslint-disable-next-line no-control-regex -- "is there anything non-ASCII" is exactly the question
  if (!/[^\x00-\x7f]/.test(raw)) return "agent";
  return `agent-${createHash("sha256").update(raw.normalize("NFC")).digest("hex").slice(0, 4)}`;
}

/** `base`, or `base-2`, `base-3`… — the first one not taken. */
export function ensureUniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
