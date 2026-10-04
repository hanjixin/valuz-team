import type { Schema } from "@agent-base/contract";
import type { RpcMethod, RpcParams } from "@agent-base/protocol";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];

const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  return { ctx, auth: await requireAuth(ctx, req), id: (req.params as { device_id?: string }).device_id ?? "" };
};

export const registerDevice: Handler = async (req, reply) => {
  const { ctx, auth } = await caller(req);
  return reply.code(201).send(await service.register(ctx, auth, (req.body as Schema<"DeviceNameRequest">).name));
};

export const listDevices: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return { devices: await service.list(ctx, auth) };
};

export const getDevice: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.get(ctx, auth, id);
};

export const updateDevice: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.rename(ctx, auth, id, (req.body as Schema<"DeviceNameRequest">).name);
};

export const revokeDevice: Handler = async (req, reply) => {
  const { ctx, auth, id } = await caller(req);
  await service.revoke(ctx, auth, id);
  return reply.code(204).send();
};

/** A remote-control operation: the request body is the RPC's parameters. */
const remote =
  <M extends RpcMethod>(method: M): Handler =>
  async (req) => {
    const { ctx, auth, id } = await caller(req);
    return service.remote(ctx, auth, id, method, (req.body ?? {}) as RpcParams<M>);
  };

export const getDeviceInfo = remote("device.info");
export const deviceFsList = remote("fs.list");
export const deviceFsStat = remote("fs.stat");
export const deviceFsRead = remote("fs.read");
export const deviceFsWrite = remote("fs.write");
export const deviceFsMkdir = remote("fs.mkdir");
export const deviceExec = remote("exec.run");
