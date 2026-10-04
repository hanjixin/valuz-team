# Upstream

The frontend (`apps/{webui,desktop,tui}`, `packages/{app,core,ui,shared,a2ui,parser-plugins,desktop-network-egress}`,
`e2e/`, `i18n/`, `docs/frontend/`) and `api/openapi.yaml` were carried over from **valuz-agent @ 9d8582a2d**.
In valuz-agent they live under `frontend/`; here the repository is flat, so every path is one level shallower.
Keep changes in those directories to the documented seams so upstream can be re-synced.

## Deliberate differences from upstream

- **Flat layout.** `frontend/apps/*` → `apps/*`, `frontend/packages/*` → `packages/*`; the frontend's root files
  (`tsconfig.base.json`, `vitest.config.ts`, `vitest.setup.ts`, `eslint.config.js`) are the repository's root files.
- **One task graph.** The frontend's own `turbo.json`, `pnpm-workspace.yaml`, and lockfile are gone; the root owns them.
- **Lint scripts** drop `--config ../../eslint.config.js`. With an explicit `--config`, ESLint resolves the config's
  `files` patterns against the working directory, so the per-file overrides never matched when run from a package.
- **Paths that counted directory levels** were shortened by one: the locale imports in `packages/shared/src/i18n/index.ts`,
  the monorepo root in `packages/shared/src/vite/preset.ts`, the repo root in `packages/core/src/api/request-usage.test.ts`.
- **No Python.** `i18n/scripts/*.py` became `scripts/i18n.mjs` (same output), and the Vite i18n HMR plugin runs it with Node.
- **`api/openapi.yaml`** was not machine-valid upstream: a duplicated `"422"` response key was removed, and the two
  schemas `/v1/onboarding/example-project` referenced but never defined were added. Two response descriptions
  containing commas inside a flow mapping (which YAML reads as extra keys) were quoted. agent-base additions (global bearer
  security, the `auth` operations, a richer `/health`) are marked with `agent-base` comments in the file.
- Tauri/Python-sidecar leftovers (`frontend/scripts/build-*.sh`, `frontend/sidecar-services/`) were not carried over.
- `apps/webui/eslint.config.js` (a Vite template leftover that upstream bypassed with `--config`) was removed so it
  cannot shadow the root config.
- A few lint rules are warnings for the carried-over directories (see the "Lint debt" block in `eslint.config.js`):
  upstream does not gate on lint, and this repository does.
- **Test scripts are scoped.** Upstream's per-package `test` scripts all point at the shared root config, whose
  `include` covers every package — fine when run once from the root, but under a task runner each package re-ran the
  whole suite. Each script now passes its own `src` directory as the filter.
- `packages/ui/src/components/connectors/ConnectorDetailPanel.test.tsx`: "places edit after the overlay actions…"
  failed upstream as written — Edit is an icon-only button and the test looked for it by text. It now reads the
  accessible name. Worth sending upstream.
- `packages/ui/src/components/conversation/markdown-heavy-plugins.test.tsx`: waited the default 1s for a cold
  dynamic import of mermaid/katex, which fails intermittently when the whole suite runs. The waits now allow 10s.
  Worth sending upstream.
- `packages/app/src/components/TemplatePrefillDialogs.test.tsx`: the test still asserted the old `border-brand`
  selected style after the action-kind picker became a `SegmentedControl`. It now asserts that control's selected
  style. Worth sending upstream.

## agent-base additions inside carried-over packages

The server is multi-user, which the frontend never had to know about. The additions are confined to:

- `packages/core/src/api/request.ts` — an `AuthProvider` seam: credentials are added to every request and a 401
  triggers one transparent token refresh and retry. `skipAuth` opts a call out. With no provider registered,
  requests behave exactly as upstream.
- `packages/core/src/api/auth-session.ts` (new) — the session store and the `/v1/auth/*` client; registers the provider.
- `packages/app/src/auth/AuthGate.tsx` (new, exported as `@valuz/app/auth`) — the sign-in page, wrapped around the
  router in `apps/webui/src/App.tsx`.
- `i18n/locales/*.json` — an `auth` namespace.
- `e2e/web/` (new) — browser tests against the built server and web app (`pnpm test:e2e`). The upstream Electron
  specs in `e2e/` still expect the Python backend and run separately as `pnpm test:e2e:desktop`.

## Contract additions

valuz-agent's `api/openapi.yaml` does not describe everything its frontend calls: about sixty paths (model channels,
connectors, projects, automations, knowledge base…) are reached by hand-written clients in `packages/core/src/api`.
As each of those modules is ported, its operations are added to the contract here, with shapes taken from the
frontend's types and the Python routes. Added so far: `auth`, `orgs`, `teams`, `shares`, `devices` (new in
agent-base), and `providers`, `settings/model-defaults`, `settings/model-options` and the project CRUD under `projects`
(existing frontend calls).

Deliberate differences in behaviour:

- Model channels belong to a member and are shared through the ladder; one shared by someone else is listed with
  `source: "org"`. The default channel and model are per member.
- Subscription channels (Claude Pro/Max, Codex · ChatGPT) are not offered by the server: they sign in through a CLI
  on the machine that runs the agent, so they will belong to a device.
- Agents and projects belong to a member and are shared through the ladder; responses carry `permission` and
  `owner_id`. An agent's slug is unique in its organization. A project's folder is on a device (`device_id`).
- There are no built-in ("official") agents yet, including the system agent.
- `GET /v1/runtimes` reports a runtime as available when an online device the caller may use has it.
