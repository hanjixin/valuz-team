/**
 * Pre-commit: lint and format what was staged — except code carried over from
 * valuz-agent (see UPSTREAM.md), which is never auto-rewritten so it stays re-syncable.
 */
const UPSTREAM =
  /^(apps\/(webui|desktop|tui)|packages\/(app|core|ui|shared|a2ui|parser-plugins|desktop-network-egress)|e2e|i18n|docs\/frontend|legacy)\//;
const ROOT_UPSTREAM = new Set([
  "vitest.config.ts",
  "vitest.setup.ts",
  "tsconfig.base.json",
  "eslint.config.js",
  "api/openapi.yaml",
  "scripts/design-audit.mjs",
  "scripts/design-audit-baseline.json",
]);

const ours = (files) =>
  files
    .map((file) => file.replace(`${process.cwd()}/`, ""))
    .filter((file) => !UPSTREAM.test(file) && !ROOT_UPSTREAM.has(file));
const quoted = (files) => files.map((file) => `"${file}"`).join(" ");

export default {
  "*.{ts,tsx,js,mjs,cjs}": (files) => {
    const own = ours(files);
    return own.length ? [`eslint --fix --no-warn-ignored ${quoted(own)}`, `prettier --write ${quoted(own)}`] : [];
  },
  "*.{json,md,yml,yaml,css}": (files) => {
    const own = ours(files);
    return own.length ? [`prettier --write --ignore-unknown ${quoted(own)}`] : [];
  },
};
