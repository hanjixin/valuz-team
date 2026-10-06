# Architecture

agent-base is the Node rewrite of valuz-agent, changed from local-first to cloud-first:
the server is the system of record, a desktop is an execution node that can be shared
with an organization and controlled remotely.

## Layout

One workspace, one `apps/` and one `packages/` — the whole repository is TypeScript.

```
api/openapi.yaml            the HTTP contract — single source of truth
i18n/locales/               locale files
apps/
  server                    the deployed server: Fastify + PostgreSQL + Redis
  host                      the desktop host process: links a machine, runs sessions on it
  webui                     browser app                                      ┐
  desktop                   Electron app                                     │ carried over from
  tui                       terminal UI (placeholder upstream)               │ valuz-agent
packages/                                                                    │ (see UPSTREAM.md)
  app · core · ui · shared · a2ui · parser-plugins · desktop-network-egress  ┘
  db                        Kysely schema, reversible migrations
  test-utils                Testcontainers helpers, stand-in model gateway
  protocol                  domain types + device-link wire protocol
  kernel                    session orchestrator + runtimes (Claude Agent, Codex, native on deepagents)
e2e/                        Playwright specs
deploy/                     the production image and stack, and the dev infra
scripts/                    dev launcher, contract coverage, i18n tooling
```

Two TypeScript bases: `tsconfig.base.json` (bundler resolution, for the browser/Electron code) and
`tsconfig.node.json` (NodeNext, for `apps/server`, `apps/host`, and the Node packages).

## Server layers

```
apps/server/src/
  app.ts                  composition root
  infra/                  config, context, cross-cutting clients — never imports a module
  modules/<name>/
    handlers.ts           one exported function per contract operationId
    service.ts            business logic; the only door other modules may use
    repo.ts               SQL for this module's tables — private to the module
```

## The built-in assistant

Every member has one agent nobody made: the assistant (小万 / Valurion, slug `valurion`, `kind: system`). It is
created the first time it is looked for, is its member's alone — not shareable, not visible to admins — and cannot
be renamed or deleted; what it runs on (runtime, model, channel, effort) is the member's to change. It names no
skills or connectors: each turn it is given everything its member can use at that moment
(`modules/agents/available.ts`). Because each member has one under the same slug, a slug is unique in the
organization only among the agents people make.

## Skills that ship, and the marketplace

Every library starts with a few skills nobody made (`modules/skills/builtin.ts`: skill-creator, docx, xlsx, pptx).
They ship with the server as one packed file (`scripts/bundle-builtin-skills.mjs` rebuilds it from a valuz-agent
checkout) rather than living in a database row: everyone reads and uses them, nobody changes them — a member who
wants a different one takes a copy.

The marketplace (`modules/marketplace`) is a public market index seen against the member's own library: the index
answers in the contract's own shapes, the server works out `installed`, and installing goes through the same doors
as doing it by hand — a skill package is downloaded, checked against the index's digest, and put in the skill
library under its market name; an agent or a team becomes agents in the library, with the skills they name fetched
on the way. Connectors are created by the app from the item's configuration; plugin bundles are not provided. An
index that is down yields an empty, `degraded` market, never an error page. `MARKETPLACE_INDEX_URLS` names the
index (empty switches the marketplace off).

A turn's skills travel to the device as packages. A device keeps each by the digest of its files, so the server
asks what the device lacks (`skills.missing`) and sends only that; the rest go by digest alone.

## Access control

Every shareable row carries `org_id` and `owner_id`. The caller's permission on it is `admin` for its owner
and for organization owners/admins, otherwise the strongest share that reaches them — granted to the whole
organization, to one of their teams, or to them — on the ladder `view < use < edit < control`. With no share
the row is invisible (404, not 403). `modules/sharing/service.ts` owns this: a module registers its table with
`registerShareable`, filters lists with `permissionOf`, and guards single rows with `requirePermission`.
Changes that matter are written to the audit trail with `audit.record`, inside the transaction that makes them.

## Devices

A desktop runs `agent-base-host`, which opens one WebSocket to the server (the _device link_,
`packages/protocol/src/wire.ts`). The server sends RPCs down it — run a turn, browse files, run a command —
and the host streams state back; every state frame is retried until the server acks it.

- `infra/device-hub.ts` is the transport: sockets held by this replica, presence in Redis, and RPC routing
  through Redis when the device is linked to another replica. Modules subscribe to what arrives (`hub.listen`).
- Permission is checked twice. The server requires `control` on the device for remote control; the host then
  applies its owner's local policy, which the server cannot override: anyone but the owner is confined to the
  folders the owner shared, and may run commands only if the owner switched that on.
- The link is a WebSocket, so it is not in the HTTP contract; routes like it are registered in `modules/setup.ts`.

## Sessions

A session is created on the server and runs on a device. Sending a message resolves what the turn needs —
the model channel's key, the agent's current instructions, the project's context — and hands it to the host
over the device link (`modules/sessions/dispatch.ts`); the session row itself holds no secrets. The host's
kernel streams events back; `modules/sessions/ingest.ts` stores each once (frames are retried until acked) and
publishes it, and `events.ts` serves the log as history, as whole-turn windows, and as a live stream that
replays from a cursor and then follows.

A session can be forked — whole, or from one of its turns. The thread itself (what the model is shown) lives with
the runtime on the device, so each finished turn records a runtime-native anchor in its message
(`metadata.runtime_native`), and forking asks the device to branch the thread (`session.fork`) before the server
copies the conversation's rows; if the device cannot, nothing is created.

The conversation UI was written against an older event vocabulary with string-only payloads;
`modules/sessions/translate.ts` maps kernel events to it at the edge.

Who may do what with a session flows from three places: the session (its owner and shares), its project
(`edit` there lets a teammate drive it, `view`/`use` watch it), and its device (`control` there is remote
control of everything on it). A session with no folder of its own — a quick chat, a project not bound to a
folder — works in a workspace the host manages (`@managed/<name>`).

## Tasks

A task is goal-driven work by a project's team. Its lead — an agent, in a session of its own — plans it as a
DAG of subtasks, dispatches each to a member (a session each), reviews what comes back, and finishes it.
`modules/tasks/plan.ts` is the plan and its transition tables (pure); `service.ts` is the orchestration.

The lead reaches the orchestrator as an MCP tool server the server itself hosts (`infra/toolkit.ts`), from
whatever device and runtime it runs on, with a token that names its session. Three things move a task, each
through one entry point: a tool call from the lead, a turn ending on a device, and a person intervening.
Every plan write happens under a row lock; anything that talks to a device runs after the commit. Messages for
a lead or member that is mid-turn wait in a mailbox and become its next turn.

A conversation can hand work to the team too: in a project with a team, the agent talking with a member is given
a second toolkit (`tasks/chat.ts`: draft, plan, commit, follow, inject), and the task it opens is that member's.

Tasks ride on sessions without sessions knowing about them: `sessions/dispatch.ts` lets other modules add to a
turn (`registerTurnExtras`) and hear when a turn ends or a session falls idle.

## Files stay on the device

Projects are local. A project's folder and a session's workspace live on a device; the server holds no copy and
gives remote access to them: a folder listing (`fs.tree`), an upload into the project, the bytes of one file —
each asked of the device when it is wanted, as the caller, so the device's owner's sharing policy applies.
A file's bytes are fetched through a short-lived token naming that one file (`POST /v1/files/resolve`).

Of a project's files, the one thing the server stores is an upload on its way: a member attaches a file before the message — and
sometimes the session — exists, so it waits in storage (`infra/storage.ts`: a directory, or an S3-compatible
store when replicas must share it) until the message is sent, is then written into the session's workspace on
the device, and is removed from the server.

What an agent delivers is recorded the same way (`modules/files/artifacts.ts`): the agent names the files that are
its result, the server notes the path and counts the version, and reading one asks the device.

## The knowledge base is on the server

The exception to "files stay on the device" is what the organization chooses to share with everyone: its
knowledge bases. A document is uploaded to storage and kept there, parsed in the background (a BullMQ queue in
Redis, so any replica parses what another accepted) into text and chunks in PostgreSQL, and searched by substring
with a trigram index — which works for languages without word boundaries. Every member reads; the creator and
organization admins change.

Agents consult it through a second server-hosted toolkit (`/v1/mcp/docs`: search, read a window, list), added to
every turn whose scope holds a document. The scope is the project's bindings — knowledge bases, folders or single
documents — or, with none, everything the organization has.

## Memory

What agents carry from one session to the next (`modules/memory`). Three scopes of short entries, each with a hard
size limit: `user` and `global` are a member's own, `project` belongs to a project and is shared with everyone who
works in it. A turn is shown what is in scope and given a `memory` tool (a third server-hosted toolkit) to add,
replace and remove entries.

What an agent did not think to keep is caught by a review (`memory/review.ts`): the session's model — on the
session's device, like everything a model does here — reads what was said since the last review and answers with
what was worth keeping, applied through the same store, so the same limits, secret redaction and scan for hidden
instructions cover both paths. A conversation is reviewed once it has been quiet for a minute, every so many turns
if it never goes quiet, and the moment a runtime compacts its context — while what the summary dropped is still in
the transcript here. A finished task is reviewed for what its team should carry forward; what an automation ran
is reviewed into its project's memory only.

Entries only pile up, so a scope is also tidied (`memory/consolidate.ts`): rewritten as a shorter list that says
the same — overlaps merged, a contradiction settled for the newer entry, stale state dropped. It happens in the
background once a scope is four-fifths full, at once when a write would not fit (tidy, then write), and when a
member asks from the settings page. The model proposes; the store decides: the result is taken whole or not at
all, passes every check a single write does, and may never hold more text than what it replaces. What the scope
held is kept as a snapshot (`memory_snapshots`, the last five), one step from being restored.

## Skills an agent writes itself

Memory keeps facts; a skill keeps how to do something. An agent can save a procedure it worked out as a skill in
its member's library, or correct a skill of theirs it found wrong (`modules/skills/learn.ts`, `tools.ts`) — as it
works, with the `skill_manage` tool (a server-hosted toolkit like the others), or afterwards: a turn that used
many tools, and every finished task, is read again by the session's own model, on its device, for a procedure
worth keeping. The reviewer is shown what was said, each tool call and how it came out, the skills that exist (so
nothing is written twice) and — in full — the ones the work used that may be corrected.

Either way the change goes through the skill library's own doors: a new skill is the member's, marked `learned`;
a correction is a new version of a skill they may edit, never of a built-in one or one merely shared for use. The
text is held to what memory is — a later agent will read it as instructions — and a review adds at most one
skill. The member is told each time, the agent that wrote a skill is given it, the version history is the way
back, and the whole thing is theirs to switch off.

## Context that outgrows the model

A long conversation is summarized by its runtime, on the device: the Claude and Codex runtimes do it themselves,
and the native one through its library's summarization (`packages/kernel/src/runtimes/deep-agent.ts`), configured
here against the model's input window — the channel's own declaration when it has one (`model_limits`, for a
gateway's aliases whose size no name reveals), the library's knowledge of the model otherwise, a fixed size
failing both. What a summary replaces is kept in full in the device's data folder, not the member's project, and
the summary names the file so the agent can read a detail back. A compaction is reported as an event, which is
what sets off the memory review above.

## Automations

An automation is an agent's work started by the clock or by hand (`modules/automations`): a conversation with an
agent, or a goal handed to a project's team as a task. The clock is BullMQ's repeating jobs (`infra/jobs.ts`), so
with several replicas each firing is delivered to exactly one. A firing runs as the automation's owner, on the
device their sessions run on, and is recorded as a run; one that finds the previous run still going is noted and
dropped. A conversation's turn ending is what tells its run how it went.

## Channels

A Feishu or WeCom bot can be bound to an agent (`modules/channels`). The server holds no connection to either
platform: the bot's long connection is dialled by a device — one of the binder's own, where the agent runs anyway
(`apps/host/src/channels.ts`, the platforms' official SDKs). The server keeps the binding and its sealed
credentials, tells the device which bots to keep connected (`channels.sync`: on every change, and whenever the
device says hello), hears from it what people said (a `channel.message` state frame, retried until acked, each
platform event taken once), and asks it to post the answer (`channels.send`). Credentials go only to a device of
the member who entered them, and the host runs bots for its owner alone.

Each chat the bot is in becomes a session with that agent, owned by whoever made the binding and run on that same
device; a turn ending sends the answer back. What the two platforms share is `channels/chat.ts`. With the device
off the bot is simply offline: the server takes no callback from either platform and posts nothing to them. The one
call it makes is checking an app's credentials when a member presses "test".

## The desktop app

`apps/desktop` is the carried-over Electron shell with its backend replaced (`src/main/services/team.ts`). There
is no local server: the app asks once which team server it belongs to, then keeps two things running — a small
reverse proxy on the local port its pages were built against, pointing at that server, and the host as a child process run by Electron's own Node. Signing in links the
computer without being asked (agents run here, so there is nothing to choose); a member who unlinks it in
Settings → Devices is not linked again until they say so. The pages
are the same ones the web app serves, behind the same sign-in.

Packaged (`pnpm --filter @valuz/desktop build`), the app carries the host as one bundled file
(`HOST_STANDALONE=1`, `apps/host/tsup.config.ts`) beside the two runtime SDKs, which find their command-line
programs on disk and so stay real packages (`packages/host-runtimes` names them). Those two programs are most of
the installer. The app archive itself holds only what the main process loads at run time — the updater and what it
needs; everything else is already in the built pages.

## Calling out on a member's behalf

A model channel's endpoint is a URL a member typed. Before the server calls one, `infra/outbound.ts` checks it
resolves only to public addresses and redirects are not followed — otherwise any member could make the server
probe its own network. `ALLOW_PRIVATE_UPSTREAMS=1` lifts this for self-hosted setups with a gateway on the LAN.
Not every channel has a credential on the server. The Claude and Codex runtimes can use the login their device
already has (a Claude Pro/Max or ChatGPT subscription), so those two are built-in channels that hold nothing
(`modules/providers/subscriptions.ts`): a session on one carries no channel, and the kernel leaves the runtime to
the device's own sign-in.

Credentials are sealed at rest with `infra/secret-box.ts` (keyed from `APP_SECRET`, per purpose) and are never
returned by the API.

The server never asks a model anything but "are you there" (checking a channel when it is added). Runtimes are on
devices: a turn runs there, and so does any one-off question the server needs answered (`session.ask`).

## Status

Ported so far: accounts, organizations, members, invites, teams, sharing, audit, devices and remote control,
the host and the kernel, model channels, model defaults and preferences, the agent library, projects and their
teams, sessions (create, send, interrupt, queue, events, fork), and the collaboration UI (Settings → Organization,
Devices, Sharing), notifications, per-turn feedback, the skill library with versions, connectors (MCP servers), approvals and session controls, multi-agent tasks, attachments and remote file access, the knowledge base, memory, the activity feed, automations, the Feishu and WeCom channels, the desktop app, agent templates and the first-run tour, the marketplace, skills agents write themselves, memory that tidies itself.
Not provided: playbooks, plugin bundles, backup.

The repository was rebuilt from a prototype (tag `prototype-v0`), module by module; the prototype itself is no
longer in the tree. `make contract` reports how much of the contract is implemented.
