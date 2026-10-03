import { defineConfig } from "tsup";

export default defineConfig([
  { entry: ["src/main.ts"], format: "esm", target: "node22", clean: true, external: ["electron"] },
  // A sandboxed preload must be CommonJS.
  { entry: ["src/preload.ts"], format: "cjs", target: "node22", external: ["electron"], outExtension: () => ({ js: ".cjs" }) },
]);
