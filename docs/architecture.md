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
  host                      the desktop host process                         (ported in phase 3)
  webui                     browser app                                      ┐
  desktop                   Electron app                                     │ carried over from
  tui                       terminal UI (placeholder upstream)               │ valuz-agent
packages/                                                                    │ (see UPSTREAM.md)
  app · core · ui · shared · a2ui · parser-plugins · desktop-network-egress  ┘
  db                        Kysely schema, reversible migrations
  test-utils                Testcontainers helpers, stand-in model gateway
  protocol                  domain types + device-link wire protocol         (ported in phase 3)
  kernel                    session orchestrator + runtimes                  (ported in phase 3)
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

## Status

The repository is being rebuilt from the prototype in `legacy/` (tag `prototype-v0`),
module by module. `make contract` reports how much of the contract is implemented.
The plan and its phases are in the project plan; the prototype's feature list and
known limits are in `legacy/README.md`.
