# agent-base

Cloud-first, team-collaborative Node rewrite of valuz-agent: no Python, PostgreSQL + Redis on the server,
desktops that can be shared with an organization and controlled remotely.

The server is the system of record and the point of coordination; a desktop is where agents run. Project files
stay on the desktop and are reached through it — see [docs/architecture.md](docs/architecture.md). Rebuilt from a
prototype (tag `prototype-v0`), module by module; `make contract` shows how much of the HTTP contract is implemented.

## Quick start

```bash
make install
make check        # format + lint + typecheck + tests (needs Docker for the integration tests)
make dev          # local PostgreSQL + Redis, server on :8787 in watch mode
make test-e2e     # browser tests: built server + web app in Chrome
pnpm test:e2e:desktop   # the Electron app against the same stack
```

`make help` lists every command.

## Deploying

The server, the device link and the web app ship as one image, with PostgreSQL and Redis beside it:

```bash
cp deploy/.env.example deploy/.env      # set APP_SECRET and POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

It listens on `127.0.0.1:8787` — put a TLS-terminating proxy in front (the device link is a WebSocket on the
same port). Migrations run on start. The first account to register owns its own organization; set
`ALLOW_SIGNUP=0` afterwards to make the server invitation-only.

Then link a computer for agents to work on:

```bash
AGENT_BASE_PASSWORD=… agent-base-host login --server https://your.server --email you@example.com
agent-base-host share add /path/others/may/use     # optional: what colleagues you share it with can reach
agent-base-host run
```
