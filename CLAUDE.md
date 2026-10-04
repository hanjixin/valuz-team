# agent-base

> Cloud-first, team-collaborative Node rewrite of valuz-agent. One TypeScript monorepo: `apps/` + `packages/`. Server: Fastify / PostgreSQL / Redis. Frontend: the valuz-agent frontend, carried over.

@docs/architecture.md — structure, layers, and where things go

## Commands

- All quality gates: `make check` (format check + lint + typecheck + tests)
- Tests: `make test-all`, or one package: `make test P=@agent-base/server`
- Type check: `make typecheck` · Lint: `make lint` · Format: `make format`
- Browser tests: `make test-e2e` (builds the server and web app, drives them in the installed Chrome)
- Dev: `make dev` (local PostgreSQL + Redis, server in watch mode)
- Migrations: `make migrate` / `make migrate-down`
- Contract coverage: `make contract` (add `-- --missing` to `pnpm contract:coverage` to list gaps)

Integration tests start PostgreSQL and Redis with Testcontainers — Docker must be running. Node-side tests live in `test/` (not `src/`): the shared root Vitest config, which is the frontend's, collects `src/**/*.test.*` in a browser environment.

## Verification

After any change run `make check`. Do not consider work complete until it passes.

## Rules

- **Contract first.** `api/openapi.yaml` is the single source of truth for HTTP. Change the contract, then the server, then the frontend. After editing it run `make generate-types`; handlers take their request and response types from `@agent-base/contract`.
- **Errors use `errorBody()`** (`apps/server/src/infra/errors.ts`): the web client reads the message from `detail`.
- **An operation is implemented** when a function named exactly after its `operationId` is exported from `apps/server/src/modules/<module>/handlers.ts`. `make contract` counts these.
- **Migrations are reversible.** Every migration in `packages/db/src/migrations` has a working `down`, and is listed in `migrations/index.ts`.
- **Routes the contract cannot describe** (WebSockets) and per-server subscriptions go in `apps/server/src/modules/setup.ts`.
- **Module boundaries.** A module's `repo.ts` is private to it; other modules call its service. `infra/` never imports a module. Lint enforces both.
- **Use a package before writing one.** Check npm, and check what valuz-agent itself uses, before hand-writing a capability.
- **The frontend apps and packages, `i18n/`, `e2e/`, and `api/openapi.yaml` came from valuz-agent** — `UPSTREAM.md` lists them and every deliberate difference. Keep changes there to the documented seams, and record new ones in that file.
- **Tests run one package at a time with at most 4 workers** (`pnpm test`). Do not run `turbo run test` or bare `vitest` across the repo without those limits — the frontend suite is large.
- **`legacy/` is the prototype** this codebase is being ported from. It is not in the workspace. Port a module, then delete its legacy copy; never import from it.
- Commits follow Conventional Commits (enforced by commitlint). Never skip hooks with `--no-verify`.
- Secrets go in `.env`, never in code.
