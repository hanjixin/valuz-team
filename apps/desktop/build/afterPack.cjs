/**
 * agent-base: put the host's node_modules into the packaged app.
 *
 * `resources/host` (made by `pnpm build:host`) is the host bundled into one
 * file, beside the two runtime SDKs it cannot bundle (they find their
 * command-line programs on disk). electron-builder copies the folder as an
 * extra resource but leaves every node_modules out, whatever the filter says —
 * so this copies that part in, before signing.
 */
const fs = require("node:fs");
const path = require("node:path");

/** Every package `name` needs at run time, found by walking the installed tree from this app. */
function closureOf(name, from, seen = new Set()) {
  let manifest;
  try {
    manifest = require.resolve(`${name}/package.json`, { paths: [from] });
  } catch {
    return seen; // an optional dependency that is not installed
  }
  if (seen.has(name)) return seen;
  seen.add(name);
  const { dependencies = {} } = JSON.parse(fs.readFileSync(manifest, "utf8"));
  for (const dependency of Object.keys(dependencies)) closureOf(dependency, path.dirname(manifest), seen);
  return seen;
}

/**
 * The app archive carries only the modules the main process loads at run time:
 * electron-updater and what it needs (the allow-list in electron-builder.yml).
 * If an upgrade gives the updater a new dependency, say so now rather than
 * ship an app that cannot start.
 */
function checkUpdaterModules(projectDir) {
  const config = fs.readFileSync(path.join(projectDir, "build", "electron-builder.yml"), "utf8");
  const listed = /"node_modules\/\{([^}]+)\}\/\*\*"/.exec(config)?.[1].split(",") ?? [];
  const missing = [...closureOf("electron-updater", projectDir)].filter((name) => !listed.includes(name));
  if (missing.length > 0)
    throw new Error(`electron-builder.yml: add ${missing.join(", ")} to the node_modules allow-list — electron-updater needs it`);
}

exports.default = async function afterPack(context) {
  checkUpdaterModules(context.packager.projectDir);
  const source = path.join(context.packager.projectDir, "resources", "host", "node_modules");
  if (!fs.existsSync(source)) throw new Error(`${source} is missing — run "pnpm build:host" first`);
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  const target = path.join(resources, "host", "node_modules");
  fs.rmSync(target, { recursive: true, force: true });
  // pnpm's layout is links into .pnpm: keep them as links, pointing where they point.
  fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  console.log(`[afterPack] host dependencies → ${target}`);
};
