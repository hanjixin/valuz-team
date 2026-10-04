import { defineConfig } from "@playwright/test";

/**
 * The desktop app, end to end: the built Electron shell against the built
 * server over PostgreSQL and Redis (the same stack the browser specs start).
 * Run with `pnpm test:e2e:desktop`, which builds everything first.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  // Electron allows one instance per user-data directory, and the app proxies on a fixed local port.
  workers: 1,
  globalSetup: "../web/global-setup.ts",
  use: { baseURL: "http://127.0.0.1:18790", trace: "retain-on-failure", actionTimeout: 15_000 },
});
