# agent-base

> Cloud-first, team-collaborative Node rewrite of valuz-agent. Backend: TypeScript / Fastify / PostgreSQL / Redis. Frontend: the valuz-agent frontend, carried over.

@docs/architecture.md — structure, layers, and where things go

## Commands

- All quality gates: `make check` (format check + lint + typecheck + tests)
- Tests: `make test-all`, or one package: `make test P=@agent-base/server`
- Type check: `make typecheck` · Lint: `make lint` · Format: `make format`
- Dev: `make dev` (local PostgreSQL + Redis, server in watch mode)
- Migrations: `make migrate` / `make migrate-down`
- Contract coverage: `make contract` (add `-- --missing` to `pnpm contract:coverage` to list gaps)

Integration tests start PostgreSQL and Redis with Testcontainers — Docker must be running.

## Verification

After any change run `make check`. Do not consider work complete until it passes.

## Rules

- **Contract first.** `api/openapi.yaml` is the single source of truth for HTTP. Change the contract, then the server, then the frontend.
- **An operation is implemented** when a function named exactly after its `operationId` is exported from `backend/apps/server/src/modules/<module>/handlers.ts`. `make contract` counts these.
- **Migrations are reversible.** Every migration in `backend/packages/db/src/migrations` has a working `down`, and is listed in `migrations/index.ts`.
- **Module boundaries.** A module's `repo.ts` is private to it; other modules call its service. `infra/` never imports a module. Lint enforces both.
- **Use a package before writing one.** Check npm, and check what valuz-agent itself uses, before hand-writing a capability.
- **`frontend/`, `i18n/`, and `api/openapi.yaml` came from valuz-agent.** Keep changes there to the documented seams so upstream can be re-synced.
- **`legacy/` is the prototype** this codebase is being ported from. It is not in the workspace. Port a module, then delete its legacy copy; never import from it.
- Commits follow Conventional Commits (enforced by commitlint). Never skip hooks with `--no-verify`.
- Secrets go in `.env`, never in code.
