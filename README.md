# agent-base

Cloud-first, team-collaborative Node rewrite of valuz-agent: no Python, PostgreSQL + Redis on the server,
desktops that can be shared with an organization and controlled remotely.

**Status: being rebuilt.** A working prototype of the whole system lives in [`legacy/`](legacy/README.md)
(tag `prototype-v0`). This tree is the engineered version it is being ported into, module by module —
see [docs/architecture.md](docs/architecture.md). Run `make contract` to see how much of the HTTP
contract is implemented so far.

## Quick start

```bash
make install
make check        # format + lint + typecheck + tests (needs Docker for the integration tests)
make dev          # local PostgreSQL + Redis, server on :8787 in watch mode
```

`make help` lists every command.
