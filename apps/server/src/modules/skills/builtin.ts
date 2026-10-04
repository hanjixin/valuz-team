/**
 * The skills every organization starts with. They ship with the server
 * (`builtin-skills.json`, packed by `scripts/bundle-builtin-skills.mjs`) rather
 * than living in anyone's library: everyone can read and use them, nobody can
 * change them — a member who wants a different one takes a copy.
 */
import type { SkillFile } from "@agent-base/db";
import matter from "gray-matter";
import packed from "./builtin-skills.json" with { type: "json" };

export interface BuiltinSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  files: SkillFile[];
}

const ID_PREFIX = "builtin-";

export const BUILTIN: BuiltinSkill[] = (packed as { slug: string; files: SkillFile[] }[]).map(({ slug, files }) => {
  const manifest = matter(files.find((file) => file.path === "SKILL.md")?.content ?? "").data as {
    name?: string;
    description?: string;
  };
  return {
    id: `${ID_PREFIX}${slug}`,
    slug,
    name: String(manifest.name ?? slug),
    description: String(manifest.description ?? ""),
    files,
  };
});

/** A built-in skill by its id or its slug. */
export const find = (key: string): BuiltinSkill | undefined =>
  BUILTIN.find((skill) => skill.id === key || skill.slug === key);

export const SLUGS: ReadonlySet<string> = new Set(BUILTIN.map((skill) => skill.slug));
