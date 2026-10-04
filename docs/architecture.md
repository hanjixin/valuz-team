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
deploy/                     Dockerfile, compose files
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

## Status

Ported so far: accounts, organizations, members, invites, teams, sharing, audit, devices and remote control,
the host, and the kernel (not yet driven by the server — sessions come next).

The repository is being rebuilt from the prototype in `legacy/` (tag `prototype-v0`),
module by module. `make contract` reports how much of the contract is implemented.
The plan and its phases are in the project plan; the prototype's feature list and
known limits are in `legacy/README.md`.
