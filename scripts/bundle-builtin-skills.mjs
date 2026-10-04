#!/usr/bin/env node
/**
 * Packs the skills every organization starts with into one JSON file the
 * server carries (apps/server/src/modules/skills/builtin-skills.json).
 * Their source is a valuz-agent checkout:
 *
 *   node scripts/bundle-builtin-skills.mjs ../valuz-agent
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCES = [
  "backend/valuz_agent/resources/official_skills/skill-creator",
  "backend/valuz_agent/resources/bundled_plugins/office/skills/docx",
  "backend/valuz_agent/resources/bundled_plugins/office/skills/xlsx",
  "backend/valuz_agent/resources/bundled_plugins/office/skills/pptx",
];

const upstream = process.argv[2];
if (!upstream) throw new Error("usage: bundle-builtin-skills.mjs <path to valuz-agent>");

async function filesUnder(dir, base = dir) {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) out.push(...(await filesUnder(full, base)));
    else out.push({ path: path.relative(base, full).split(path.sep).join("/"), content: await readFile(full, "utf8") });
  }
  return out;
}

const skills = [];
for (const source of SOURCES) {
  const files = await filesUnder(path.join(upstream, source));
  const slug = path.basename(source);
  skills.push({ slug, files });
}
const target = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../apps/server/src/modules/skills/builtin-skills.json",
);
await writeFile(target, `${JSON.stringify(skills)}\n`);
console.log(`${skills.length} skills, ${skills.reduce((n, s) => n + s.files.length, 0)} files → ${target}`);
