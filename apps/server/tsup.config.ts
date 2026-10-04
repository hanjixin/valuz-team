import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/migrate-cli.ts"],
  format: "esm",
  target: "node22",
  clean: true,
  // Workspace packages ship as TypeScript source, so bundle them in — but never
  // their npm dependencies (CommonJS ones such as `pg` cannot live in an ESM bundle).
  // Those stay external, so each must also be listed in this package's own dependencies.
  noExternal: [/^@agent-base\//],
  skipNodeModulesBundle: true,
});
