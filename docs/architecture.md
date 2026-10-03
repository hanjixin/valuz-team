# Architecture

agent-base is the Node rewrite of valuz-agent, changed from local-first to cloud-first:
the server is the system of record, a desktop is an execution node that can be shared
with an organization and controlled remotely.

## Layout

```
api/openapi.yaml          the HTTP contract — single source of truth
i18n/                     locale files (from valuz-agent)
frontend/                 the valuz-agent frontend (apps + packages), reused
backend/
  packages/db             Kysely schema, reversible migrations
  packages/test-utils     Testcontainers helpers, stand-in model gateway
  packages/protocol       domain types + device-link wire protocol      (ported in phase 3)
  packages/kernel         session orchestrator + runtimes               (ported in phase 3)
  apps/server             the deployed server: Fastify + PostgreSQL + Redis
  apps/host               the desktop host process                      (ported in phase 3)
deploy/                   Dockerfile, compose files
scripts/                  dev launcher, contract coverage
legacy/                   the working prototype being ported from (not in the workspace)
```

## Server layers

```
backend/apps/server/src/
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
