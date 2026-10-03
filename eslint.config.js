import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Backend lint. The frontend keeps its own config (`frontend/eslint.config.js`,
 * carried over from valuz-agent) and is linted from there.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".turbo/**",
      "legacy/**",
      "frontend/**",
      "i18n/**",
      "**/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,mts,mjs,js}"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.node } },
    rules: {
      // `_` marks a deliberately discarded binding, including rest-destructuring used to drop a field.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },
  {
    // Module boundary contract for the server (the Node counterpart of valuz's `check-boundaries`):
    // a module's repository is private to it; other modules go through its service.
    files: ["backend/apps/server/src/**/*.ts"],
    plugins: { boundaries },
    settings: {
      "boundaries/include": ["backend/apps/server/src/**/*"],
      "boundaries/elements": [
        { type: "repo", pattern: "backend/apps/server/src/modules/*/repo.ts", mode: "file", capture: ["module"] },
        { type: "module", pattern: "backend/apps/server/src/modules/*", capture: ["module"] },
        { type: "infra", pattern: "backend/apps/server/src/infra" },
      ],
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "allow",
          rules: [
            {
              from: ["module"],
              disallow: [["repo", { module: "!${from.module}" }]],
              message: "Another module's repo is private — call its service instead.",
            },
            { from: ["infra"], disallow: ["module", "repo"], message: "infra must not depend on business modules." },
          ],
        },
      ],
    },
  },
);
