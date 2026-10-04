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
  kernel                    session orchestrator + runtimes (Claude Agent, Codex, native)
e2e/                        Playwright specs
deploy/                     the production image and stack, and the dev infra
scripts/                    dev launcher, contract coverage, i18n tooling
legacy/                     the working prototype being ported from (not in the workspace)
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

Tasks ride on sessions without sessions knowing about them: `sessions/dispatch.ts` lets other modules add to a
turn (`registerTurnExtras`) and hear when a turn ends or a session falls idle.

## Calling out on a member's behalf

A model channel's endpoint is a URL a member typed. Before the server calls one, `infra/outbound.ts` checks it
resolves only to public addresses and redirects are not followed — otherwise any member could make the server
probe its own network. `ALLOW_PRIVATE_UPSTREAMS=1` lifts this for self-hosted setups with a gateway on the LAN.
Credentials are sealed at rest with `infra/secret-box.ts` (keyed from `APP_SECRET`, per purpose) and are never
returned by the API.

## Status

Ported so far: accounts, organizations, members, invites, teams, sharing, audit, devices and remote control,
the host and the kernel, model channels, model defaults and preferences, the agent library, projects and their
teams, sessions (create, send, interrupt, queue, events), and the collaboration UI (Settings → Organization,
Devices, Sharing), notifications, per-turn feedback, the skill library with versions, connectors (MCP servers), approvals and session controls, and multi-agent tasks. Not yet: fork, regenerate,
knowledge base, automations, channels, storage.

The repository is being rebuilt from the prototype in `legacy/` (tag `prototype-v0`),
module by module. `make contract` reports how much of the contract is implemented.
The plan and its phases are in the project plan; the prototype's feature list and
known limits are in `legacy/README.md`.
