.DEFAULT_GOAL := help
.PHONY: docker-build test-e2e generate-types help install dev infra infra-down test test-all typecheck lint format check migrate migrate-down contract generate-types build clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	pnpm install

dev: ## Start local PostgreSQL + Redis and the server in watch mode
	./scripts/dev.sh

infra: ## Start local PostgreSQL + Redis only
	./scripts/dev.sh infra

infra-down: ## Stop local PostgreSQL + Redis (data preserved)
	./scripts/dev.sh down

test: ## Run one package's tests (usage: make test P=@agent-base/db)
	pnpm --filter $(P) test

test-all: ## Run all tests (integration tests start PostgreSQL/Redis with Testcontainers; needs Docker)
	pnpm test

test-e2e: ## Browser tests: builds the server and web app, runs them over real PostgreSQL/Redis in Chrome
	pnpm test:e2e

docker-build: ## Build the deployable server image (server + web app)
	docker build -f deploy/Dockerfile -t agent-base-server:latest .

typecheck: ## Type check everything
	pnpm typecheck

lint: ## Lint everything (packages, root scripts, and the module-boundary contract)
	pnpm lint

format: ## Format all code
	pnpm format

check: ## All quality gates: format check + lint + typecheck + tests
	pnpm check

migrate: ## Apply database migrations (needs DATABASE_URL)
	pnpm --filter @agent-base/server migrate up

migrate-down: ## Roll back the last migration (needs DATABASE_URL)
	pnpm --filter @agent-base/server migrate down

contract: ## Show how much of api/openapi.yaml the server implements
	pnpm contract:coverage

generate-types: ## Regenerate contract types (after editing api/openapi.yaml) and i18n key types
	pnpm contract:generate && pnpm i18n:gen

build: ## Build everything
	pnpm build

clean: ## Remove build output
	pnpm turbo run clean && rm -rf .turbo
