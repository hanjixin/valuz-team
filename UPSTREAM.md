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
- `packages/app/src/pages/ConversationsHomePage.tsx` and `packages/app/src/pages/conversation/useComposerSelection.ts`
  (the same code twice): the effect that falls back to the first available runtime
  overwrote the configured default runtime when the defaults and the runtime list arrived in the same commit — it
  compared against the selection the render saw rather than the one just queued. Invisible upstream, where the
  default is usually also the first runtime; here a member whose default is Valuz Agent got Claude Agent. It now
  decides inside a functional update. Worth sending upstream.
- `packages/app/src/components/TemplatePrefillDialogs.test.tsx`: the test still asserted the old `border-brand`
  selected style after the action-kind picker became a `SegmentedControl`. It now asserts that control's selected
  style. Worth sending upstream.

- **The desktop app has no local backend.** `apps/desktop/src/main/services/sidecar.ts` (which started the Python
  `valuz-server`) and its tests are gone; `services/mod.ts` keeps the service-manager interface and
  `services/team.ts` implements it: a reverse proxy on the port the renderer was built against, pointing at the
  team's server, plus supervision of `agent-base-host`. The renderer gained a connect screen, the sign-in gate and
  the collaboration sections (`renderer/App.tsx`, `renderer/main.tsx`, `renderer/components/ConnectScreen.tsx`);
  its two startup tests take the member as signed in. `tsconfig.base.json` maps `@valuz/app/auth` and
  `@valuz/app/team`. Network-egress management is still wired but manages nothing: the host makes its own calls.
  The installer bundles the host (`pnpm build:host` → `resources/host`); building a signed installer has not been
  exercised here.
- Upstream's desktop end-to-end specs (`e2e/*.spec.ts`, `e2e/fixtures/`) drove the app against the Python backend
  and were removed; `e2e/desktop/` drives the new one.

- **Entry points to what the server does not provide are left out**, by one list:
  `packages/core/src/edition/availability.ts`. It hides the plugin-bundle tab and the marketplace buttons
  (`PluginsPage.tsx`, which now opens on skills, and `AgentsPage.tsx`), the 执行手册 title switch
  (`AutomationHubTitle.tsx`), the automation template library tab (`AutomationPage.tsx`), and the browser, parsing
  and backup settings sections (`edition/registries/settings-sections.ts`). The routes themselves are untouched,
  and the listings those pages still read on load (`/v1/plugins`, `/v1/plugins/memberships`,
  `/v1/marketplace/categories`, `/v1/marketplace/items`) answer empty rather than "not implemented";
  upstream's `PluginsPage` tests switch the entries back on.

## agent-base additions inside carried-over packages

The server is multi-user, which the frontend never had to know about. The additions are confined to:

- `packages/core/src/api/request.ts` — an `AuthProvider` seam: credentials are added to every request and a 401
  triggers one transparent token refresh and retry. `skipAuth` opts a call out. With no provider registered,
  requests behave exactly as upstream.
- `packages/core/src/api/auth-session.ts` (new) — the session store and the `/v1/auth/*` client; registers the provider.
- `packages/app/src/auth/AuthGate.tsx` (new, exported as `@valuz/app/auth`) — the sign-in page, wrapped around the
  router in `apps/webui/src/App.tsx`.
- `i18n/locales/*.json` — an `auth` namespace and a `team` namespace.
- `packages/core/src/api/team-api.ts` (new) — client for the organization, devices and shares.
- `packages/app/src/team/` (new, exported as `@valuz/app/team`) — the collaboration UI: three settings sections
  (Organization, Devices, Sharing) and the share dialog. They are contributed through the frontend's own plugin
  mechanism (`registerPlugin` with `settingsSections`), registered in `apps/webui/src/main.tsx`, so no upstream
  page is edited to make room for them. Sharing lists everything the member owns in one place for the same reason.
- `e2e/web/` (new) — browser tests against the built server and web app (`pnpm test:e2e`). The upstream Electron
  specs in `e2e/` still expect the Python backend and run separately as `pnpm test:e2e:desktop`.

## Contract additions

valuz-agent's `api/openapi.yaml` does not describe everything its frontend calls: about sixty paths (model channels,
connectors, projects, automations, knowledge base…) are reached by hand-written clients in `packages/core/src/api`.
As each of those modules is ported, its operations are added to the contract here, with shapes taken from the
frontend's types and the Python routes. Added so far: `auth`, `orgs`, `teams`, `shares`, `devices` (new in
agent-base), and `providers`, `settings/model-defaults`, `settings/model-options` and the project CRUD under `projects`
(existing frontend calls), `connectors`, `automations`, and the knowledge base (`kb`, `projects/{id}/kb-bindings`, and the
fields the frontend reads on `docs`).

Deliberate differences in behaviour:

- Model channels belong to a member and are shared through the ladder; one shared by someone else is listed with
  `source: "org"`. The default channel and model are per member.
- Subscription channels (Claude Pro/Max, Codex · ChatGPT) are two built-in channels with the ids the app already
  uses (`ch-claude-subscription`, `ch-codex-subscription`). They hold no credential: agents run on a device, and a
  session on one carries no channel, so its runtime uses the login that device already has. They are on for every
  member unless switched off, and are always reported `available` — the server cannot see a device's CLI login,
  and the browser asking may not be on the device at all; a device that is not signed in says so when a turn runs.
  With no channel named, a Claude or Codex session whose member's default channel cannot drive that runtime runs
  on the device's login rather than being refused.
- Agents and projects belong to a member and are shared through the ladder; responses carry `permission` and
  `owner_id`. An agent's slug is unique in its organization. A project's folder is on a device (`device_id`).
- There are no built-in ("official") agents; the general assistant (`valurion`) is an ordinary agent the first-run
  tour creates in the member's library.
- A session runs on a device (`device_id`); `POST /v1/sessions` picks the project's device or the caller's own
  when none is named. Deltas are stored as well as final messages, so history replays exactly what a live
  stream showed, and every frame carries the durable `seq`.
- The native runtime (`deepagents`) is built on the `deepagents` JS library (LangGraph), with MCP servers attached
  through `@langchain/mcp-adapters`. It speaks chat completions or Anthropic messages, whichever the session's
  channel does. Its file and shell tools are the library's (`read_file`, `write_file`, `edit_file`, `execute`, …),
  acting on the session's folder; a session's thread is kept in one JSON file per session rather than in a database
  checkpointer, because the library's durable savers are native modules and the desktop runs the host under
  Electron's Node. The hand-written loop it replaced is still in the kernel as runtime `valuz_agent`.
- Fork works for the native and Claude runtimes; Codex answers 422. The native runtime's anchors stop being valid
  once the thread is compacted (409) — fork the whole conversation instead. A forked quick chat gets a project of
  its own and shares the source's workspace folder. `regenerate`, `messages/sync` and per-session skills are not
  implemented (the app does not call them).
- Skills live in the database, not in a folder on disk: a skill is its files plus every earlier version of them,
  and an agent's skills are written to the device for each turn. `path` in responses is a label, not a location.
  Per-project enablement is not modelled — a member's library switch is the only one. `POST /v1/skills/scan` has
  nothing to scan and returns the count.
- Connectors: only servers that take a key or nothing — OAuth-protected MCP servers are not supported yet
  (`discover` always answers "no OAuth"), and there is no directory of ready-made connectors. A `stdio` connector
  runs on the device, so it cannot be tested from the server.
- Files: a project's files are read from and written to its device on request; nothing is copied to the server.
  `POST /v1/files/resolve` always answers `kind: "remote"` with a tokenised address on this server, which fetches
  the bytes from the device. Attachments are staged on the server only until their message is sent. An agent marks its deliverables with the `deliver_artifacts` tool
  (a server-hosted toolkit); the server records which file and which version, never the bytes, and a version is a
  delivery, not a snapshot — the file on the device is always the latest. A knowledge-base document attached to a message
  (`/v1/attachments/kb`) is a reference until the message is sent, when its parsed text is written to the device.
- Knowledge bases are the one kind of content the server keeps: they belong to the organization, not to a folder
  on a device, so `root_path` is empty and there is nothing to auto-discover. Documents arrive by upload
  (`POST /v1/kb/{id}/files`); `docs/import` and `docs/import-folder` stay unimplemented. Every member reads; the
  creator and organization admins change (`editable`). A folder is a path prefix, not a row. Search is substring
  matching over parsed text (PostgreSQL trigrams) — no embeddings, and no OCR for scanned documents.
  A document's original file is opened through the file service (`source_path` is a `kb/<id>/<name>` reference,
  resolved to the stored upload). A project with no bindings
  consults every knowledge base of its organization.
- Memory is rows in PostgreSQL, not files on a disk. `user` and `global` are a member's own (per organization);
  `project` memory belongs to the project, so everyone who can see the project reads it and whoever can edit it
  prunes it. It is rendered into every turn rather than frozen when the session is created. The background review
  is a question put to the session's own device (`session.ask`), answered there by the session's runtime with its
  own key or login and stored nowhere — the server calls no model itself. A finished multi-agent task is reviewed
  too, from its plan, its result and its lead's transcript.
- Automations run an agent — a conversation, or a team task — by cron, by interval, or by hand. Not supported, and
  refused when asked for: code execution, playbooks, worktrees, and event triggers (`event-sources` is empty).
  An automation belongs to its creator and runs as them, on the device their sessions run on; whoever can see its
  project sees it, and its owner or the project's editors change it. A run that starts a task succeeds once the
  task is handed over; `task_status` follows the task. Proposals made by an agent in chat are not implemented.
  The shortest interval is `AUTOMATION_MIN_INTERVAL_SECONDS` (30).
- Channels: Feishu bots and WeCom smart bots (`wecom-aibot`, over the long connection, through the official
  `@wecom/aibot-node-sdk`). The WeCom self-built-app HTTP callbacks stay unimplemented. A bot is bound to an agent by whoever may edit
  the agent, one binding per agent in the organization; `channel_instance_id` is the binding's id and the last
  segment of its callback URL. The conversations people have with the bot are the binder's own sessions (a quick
  chat per Feishu chat), on the binder's device. Events arrive only over the long connection the binder's device dials (the server holds none; `connection_status` is what that device reports, `disconnected` while it is away). There is no HTTP callback: `feishuChannelCallback` is unimplemented, a Verification Token or Encrypt Key sent with a binding is ignored, and `has_verification_token` / `has_encrypt_key` are always false. Text messages only. Chats are bound to projects as upstream does (`/v1/channels/feishu/chats`, `/v1/channels/chat-bindings` — added to the contract, which upstream's file lacks), with two differences: the Feishu calls are made by the bot's device, so listing, creating and dissolving groups need it online; and a binding belongs to the member's bot rather than to a single `feishu-main` instance (`channel_instance_id` is the bot binding's id, and the value the app sends is ignored). WeCom groups cannot be bound.
- Skills an agent writes itself are new here (valuz-agent has only the member-driven skill-creator flow): the
  `skill_manage` toolkit, the review after a turn or task, `creation_origin: "learned"` (added to the contract's
  enum, shown as a badge), `GET/PATCH /v1/skills/settings`, and a switch at the top of the skills pane
  (`SkillsPane.tsx`).
- Memory: `POST /v1/memory/consolidate` and `/restore`, `MemoryView.snapshots`, and "整理 / 还原" on the memory
  settings page (`MemorySection.tsx`) are additions. The review also runs on compaction, every
  `MEMORY_REVIEW_EVERY_TURNS` turns, and for automation sessions (project scope only).
- A channel's models can declare an input window (`model_limits` on create/update, `LLMModel.max_input_tokens`);
  there is no field for it in the channel form yet — it is set through the API.
- Skill import takes a zip or a link (`/v1/skills/import/archive`, `/url`, and their confirms); importing a
  directory on the server's disk, and the skill-creator staging flow, stay unimplemented. The preview's file tree
  nests (`children`, added to the contract).
- Project export/import uses this repository's own pack format (`kind: "project-pack"`), not upstream's
  schema_version 2 pack: a project exported by valuz-agent cannot be imported here, nor the reverse. A project's
  files and per-project skill settings are not carried. `/v1/projects/{id}/connectors` is added to the contract;
  `/worktrees` answers with none.
- The project page hides its playbooks tab and panel (`ProjectDetailPage.tsx`, `use-project-playbooks.ts`); the
  sidebar's own Settings entry is dropped when an account menu is given (`ProjectLayoutBase.tsx`).
- Packaging (`apps/desktop/build`): the app archive leaves out all of node_modules and names back only what the
  main process loads at run time (electron-updater and its dependencies) — upstream excludes a list of large
  packages instead, and its test of that list is changed to match. `afterPack.cjs` is new: it checks that
  allow-list and copies the bundled host's node_modules in.
- Built-in skills are skill-creator and the office plugin's docx / xlsx / pptx, served read-only to every member
  (`source: "builtin"`, ids `builtin-<slug>`). valuz-handbook, automation, browser, citation and
  valuz-project-docs are not carried: they describe features this server does not have.
- The marketplace reads the same market index (`MARKETPLACE_INDEX_URLS`, tried in order) but has no direct
  SkillHub / ModelScope fallback: with the index down it is empty and `degraded`. Plugin bundles and playbook
  templates are not offered (automation templates are: the automation page's template library reads them) — their tab and the skills "suites" shelf are hidden
  (`MarketplacePage.tsx`). Installs record no provenance row. A market skill keeps its market slug, which is how
  `installed` is told.
- Connectors that are signed in to (OAuth) work as upstream's do from the app's side — `needs_auth` + `authorization_url`, the popup's `connector_oauth_success` message, re-signing-in by creating again under the same slug — on the MCP SDK's own OAuth client helpers. `PUBLIC_URL` names where the browser returns. Not carried: sharing one sign-in between connectors of the same service, and a published client-metadata document. The recommended list is upstream's catalogue without its Valuz data-service entries.
- The built-in assistant (Valurion / 小万) is one per member of an organization rather than one per installation;
  its product instructions are not carried over (it runs with none of its own), and `effective-resources` lists the
  member's enabled skills and connectors and the organization's knowledge bases.
- Agent templates and the first-run tour use the 24 bundled team packs, copied from valuz-agent's
  `backend/valuz_agent/resources/agent_packs` into `apps/server/src/modules/templates/packs` and reduced to what is
  read (each team and its roles' names, descriptions and instructions). The skills and connectors the packs name are
  not bundled, so a role arrives with its instructions only. A role's slug is unique in the organization: the first
  member to add it gets the plain slug, a colleague gets `<slug>-<their id prefix>`. The example project has no
  folder of its own (it works in a workspace the device manages). An exported pack (`.valuzpack`, a zip) carries the agents and the
  skills they use; connectors are named, not carried, and are listed for the importer to set up.
- `GET /v1/runtimes` reports a runtime as available when an online device the caller may use has it.
