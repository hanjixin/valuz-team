import { defineConfig } from "@playwright/test";

/**
 * Browser end-to-end tests against the real thing: the built server (serving
 * the built web app) over PostgreSQL and Redis started by Testcontainers.
 * Run with `pnpm test:e2e`, which builds both first. Uses the installed Chrome,
 * so no browser download is needed.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  workers: 1,
  globalSetup: "./global-setup.ts",
  // An action that cannot happen fails in seconds and says which one, instead of running out the test's clock.
  use: { baseURL: "http://127.0.0.1:18790", channel: "chrome", trace: "retain-on-failure", actionTimeout: 10_000 },
});
