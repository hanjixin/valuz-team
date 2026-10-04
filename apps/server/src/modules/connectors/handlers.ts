import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];
const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  return { ctx, auth: await requireAuth(ctx, req), key: (req.params as { connector_id?: string }).connector_id ?? "" };
};

export const listConnectors: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return { connectors: await service.list(ctx, auth) };
};

export const createConnector: Handler = async (req, reply) => {
  const { ctx, auth } = await caller(req);
  return reply.code(201).send(await service.create(ctx, auth, req.body as Schema<"CreateConnectorRequest">));
};

export const getConnector: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.get(ctx, auth, key);
};

export const updateConnector: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.update(ctx, auth, key, req.body as Schema<"UpdateConnectorRequest">);
};

export const deleteConnector: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  await service.remove(ctx, auth, key);
  return { ok: true };
};

export const enableConnector: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.setEnabled(ctx, auth, key, true);
};

export const disableConnector: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.setEnabled(ctx, auth, key, false);
};

export const testConnector: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.test(ctx, auth, key);
};

/** OAuth-protected servers are not supported yet: every server is treated as taking a key or nothing. */
export const discoverConnector: Handler = async (req) => {
  await caller(req);
  return {
    auth_type: "none",
    discovered: false,
    oauth_authorization_endpoint: null,
    oauth_token_endpoint: null,
    oauth_registration_endpoint: null,
  };
};

/** There is no directory of ready-made connectors yet. */
export const listRecommendedConnectors: Handler = async (req) => {
  await caller(req);
  return { items: [] };
};
