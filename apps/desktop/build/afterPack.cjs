/**
 * agent-base: put the host's dependencies into the packaged app.
 *
 * `resources/host` (made by `pnpm build:host`) is copied by electron-builder as
 * an extra resource, but without its node_modules — electron-builder leaves
 * those out of extra resources whatever the filter says. The host is a Node
 * program run by Electron's own Node, so it needs them beside it.
 */
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
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
