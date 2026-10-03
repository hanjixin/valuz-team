/**
 * Skills materialization. Skills live in the shared cloud library; for each
 * session the kernel writes the bundles the agent is equipped with into a
 * private directory shaped as a Claude Code plugin:
 *
 *     <skillsDir>/.claude-plugin/plugin.json
 *     <skillsDir>/skills/<slug>/SKILL.md (+ any other bundle files)
 *
 * The Claude runtime loads that directory as a local plugin; the other
 * runtimes read the index (`skillIndexPrompt`) and open SKILL.md on demand.
 * Nothing is written into the user's project folder.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillBundle } from "@agent-base/protocol";

export interface MaterializedSkill {
  slug: string;
  name: string;
  description: string;
  skillFile: string;
}

const SAFE_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Read `name` / `description` from a SKILL.md YAML frontmatter block. */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match?.[1]) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv?.[1] && kv[2] !== undefined) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { name: out["name"], description: out["description"] };
}

export async function materializeSkills(
  skillsDir: string,
  bundles: readonly SkillBundle[],
): Promise<MaterializedSkill[]> {
  await rm(skillsDir, { recursive: true, force: true });
  if (bundles.length === 0) return [];
  await mkdir(path.join(skillsDir, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(skillsDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "workspace-skills", version: "1.0.0", description: "Shared skills" }),
  );
  const out: MaterializedSkill[] = [];
  for (const bundle of bundles) {
    if (!SAFE_SLUG.test(bundle.slug)) throw new Error(`invalid skill slug: ${bundle.slug}`);
    const root = path.join(skillsDir, "skills", bundle.slug);
    let meta: { name?: string; description?: string } = {};
    for (const file of bundle.files) {
      const target = path.resolve(root, file.path);
      // A bundle path must never escape its own skill directory.
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`skill ${bundle.slug}: path escapes bundle: ${file.path}`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
      if (file.path === "SKILL.md") meta = parseSkillFrontmatter(file.content);
    }
    out.push({
      slug: bundle.slug,
      name: meta.name ?? bundle.slug,
      description: meta.description ?? "",
      skillFile: path.join(root, "SKILL.md"),
    });
  }
  return out;
}

/** System-prompt index for runtimes with no native skill discovery. */
export function skillIndexPrompt(skills: readonly MaterializedSkill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description} (read ${s.skillFile} before using)`);
  return (
    "## Skills\n" +
    "You are equipped with the skills below. When a task matches one, read its SKILL.md " +
    "file first and follow it.\n" +
    lines.join("\n")
  );
}
