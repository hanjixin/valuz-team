# The deployable server: the API, the device link, and the web app, in one image.
#   docker build -f deploy/Dockerfile -t agent-base-server .

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
# Manifests first, so dependency installation is cached until one of them changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# (The host is here only because the server's tests depend on it; the workspace must resolve.)
COPY apps/host/package.json apps/host/
COPY apps/server/package.json apps/server/
COPY apps/webui/package.json apps/webui/
COPY packages/a2ui/package.json packages/a2ui/
COPY packages/app/package.json packages/app/
COPY packages/contract/package.json packages/contract/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/desktop-network-egress/package.json packages/desktop-network-egress/
COPY packages/parser-plugins/package.json packages/parser-plugins/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
# Only what the server and the web app need — not the desktop shell and its Electron download.
# (The root package's git hooks have no place in an image.)
RUN pnpm install --frozen-lockfile --ignore-scripts \
      --filter "@agent-base/server..." --filter "@valuz/webui..."
COPY tsconfig.base.json tsconfig.node.json ./
COPY api api
COPY i18n i18n
COPY scripts scripts
COPY apps/server apps/server
COPY apps/webui apps/webui
COPY packages packages
# Served from the same origin as the API.
RUN VITE_API_BASE_URL=/ pnpm --filter @valuz/webui build \
 && pnpm --filter @agent-base/server build
# The server's own production dependencies, laid out on their own. Its workspace
# packages are compiled into the bundle, so only third-party modules are needed.
RUN pnpm --filter @agent-base/server deploy --prod --legacy --ignore-scripts /out

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY --from=build /out/node_modules node_modules
COPY --from=build /out/package.json package.json
COPY --from=build /repo/apps/server/dist dist
COPY --from=build /repo/apps/webui/dist dist/web
# Where uploads are staged; a volume is mounted here in the compose stack.
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
# Migrations are safe to run from every replica at once: the migrator takes a lock.
CMD ["sh", "-c", "node dist/migrate-cli.js up && exec node dist/main.js"]
