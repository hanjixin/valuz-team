#!/usr/bin/env node
/**
 * Contract coverage: how many operations of api/openapi.yaml the server implements.
 *
 * Convention: an operation is implemented when a function named exactly after its
 * operationId is exported from a `modules/<name>/handlers.ts` in the server.
 *
 *   node scripts/contract-coverage.mjs            # summary by tag
 *   node scripts/contract-coverage.mjs --missing  # also list what is not implemented
 *   node scripts/contract-coverage.mjs --min 40   # exit 1 if fewer than 40 are implemented
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spec = parse(readFileSync(path.join(root, "api/openapi.yaml"), "utf8"));
const METHODS = ["get", "post", "put", "patch", "delete"];

const operations = [];
for (const [route, item] of Object.entries(spec.paths ?? {})) {
  for (const method of METHODS) {
    const op = item[method];
    if (op)
      operations.push({ id: op.operationId, tag: op.tags?.[0] ?? "untagged", method: method.toUpperCase(), route });
  }
}
const unnamed = operations.filter((o) => !o.id);
if (unnamed.length) {
  console.error(`operations without an operationId:\n${unnamed.map((o) => `  ${o.method} ${o.route}`).join("\n")}`);
  process.exit(1);
}

const modulesDir = path.join(root, "apps/server/src/modules");
const implemented = new Set();
for (const name of readdirSync(modulesDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  let source;
  try {
    source = readFileSync(path.join(modulesDir, name.name, "handlers.ts"), "utf8");
  } catch {
    continue;
  }
  for (const match of source.matchAll(/^export (?:async )?function (\w+)|^export const (\w+)/gm))
    implemented.add(match[1] ?? match[2]);
}

const byTag = new Map();
for (const op of operations) {
  const row = byTag.get(op.tag) ?? { done: 0, total: 0, missing: [] };
  row.total += 1;
  if (implemented.has(op.id)) row.done += 1;
  else row.missing.push(`${op.method} ${op.route} (${op.id})`);
  byTag.set(op.tag, row);
}
const done = operations.filter((o) => implemented.has(o.id)).length;
const showMissing = process.argv.includes("--missing");
for (const [tag, row] of [...byTag].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`${tag.padEnd(22)} ${String(row.done).padStart(3)}/${row.total}`);
  if (showMissing) for (const line of row.missing) console.log(`    ${line}`);
}
console.log(`\ncontract coverage: ${done}/${operations.length} operations implemented`);

const min = process.argv.indexOf("--min");
if (min >= 0 && done < Number(process.argv[min + 1])) {
  console.error(`coverage fell below the required ${process.argv[min + 1]}`);
  process.exit(1);
}
