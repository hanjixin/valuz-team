import { defineConfig } from "tsup";

/**
 * Two builds. The default one leaves npm packages to node_modules, as any Node
 * program in this workspace does. `HOST_STANDALONE=1` is for the desktop app:
 * everything is bundled into the one file, so the packaged app carries a few
 * megabytes of host rather than its whole dependency tree — except the two
 * runtimes' SDKs, which find their command-line programs beside themselves on
 * disk and so have to stay real packages (see `packages/host-runtimes`).
 */
const standalone = process.env["HOST_STANDALONE"] === "1";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  target: "node22",
  clean: true,
  ...(standalone
    ? {
        outDir: "dist-standalone",
        noExternal: [/.*/],
        external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"],
        // Bundled CommonJS packages still expect require() for Node's own modules, and __dirname.
        banner: {
          js: [
            'import { createRequire as __createRequire } from "node:module";',
            'import { fileURLToPath as __fileURLToPath } from "node:url";',
            'import { dirname as __pathDirname } from "node:path";',
            "const require = __createRequire(import.meta.url);",
            "const __filename = __fileURLToPath(import.meta.url);",
            "const __dirname = __pathDirname(__filename);",
          ].join("\n"),
        },
      }
    : {
        // Workspace packages ship as TypeScript source, so bundle them in.
        noExternal: [/^@agent-base\//],
      }),
});
