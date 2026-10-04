/**
 * Contract-driven routing. Every route, its request validation, and its
 * response shape come from api/openapi.yaml; a handler is bound to an operation
 * by being exported under that operation's id. An operation with no handler
 * answers 501, so the contract can be served in full while it is implemented
 * piece by piece.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_FILE } from "@agent-base/contract";
import type { FastifyInstance, FastifyRequest } from "fastify";
import openapiGlue from "fastify-openapi-glue";
import { parse } from "yaml";
import type { Handler } from "./context.ts";
import { errorBody, unauthorized } from "./errors.ts";

/**
 * The contract uses Google-style custom verbs (`/v1/tasks/{task_id}:commit`). To the
 * router a colon starts a parameter, so those paths are rewritten for routing only:
 * a literal colon is written `::`, and a parameter directly followed by a verb is
 * constrained (`:task_id(^[^:/]+)::commit`) so sibling verbs stay distinct routes.
 */
export function routablePaths<T extends { paths?: Record<string, unknown> }>(spec: T): T {
  const paths: Record<string, unknown> = {};
  for (const [route, item] of Object.entries(spec.paths ?? {})) {
    const rewritten = route
      .split("/")
      .map((segment) =>
        segment.replace(/^(\{[A-Za-z_]+\}):([a-z-]+)$/, "$1(^[^:/]+)::$2").replace(/^([a-z-]+):([a-z-]+)$/, "$1::$2"),
      )
      .join("/");
    paths[rewritten] = item;
  }
  return { ...spec, paths };
}

/**
 * The contract declares OpenAPI 3.1 but still marks optional values with 3.0's
 * `nullable: true`, which is not a JSON Schema keyword. Rewrite it to the 3.1
 * form the validator understands: a `null` member in `type` (and in `enum`, when
 * there is one), or an `anyOf` with `null` where the schema has no `type` of its
 * own (a `$ref`, an `allOf`…).
 */
export function normalizeNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeNullable);
  if (node === null || typeof node !== "object") return node;
  const { nullable, ...rest } = node as Record<string, unknown>;
  const out = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, normalizeNullable(value)]));
  if (nullable !== true) return out;
  // A nullable enum is meant to admit null even when the list does not spell it out.
  if (Array.isArray(out["enum"]) && !out["enum"].includes(null)) out["enum"] = [...out["enum"], null];
  if (typeof out["type"] === "string") return { ...out, type: [out["type"], "null"] };
  if (Array.isArray(out["type"])) return { ...out, type: [...new Set([...(out["type"] as string[]), "null"])] };
  const { description, ...schema } = out;
  return { ...(description === undefined ? {} : { description }), anyOf: [schema, { type: "null" }] };
}

/**
 * An upload arrives as a multipart stream that the handler reads file by file;
 * there is no parsed body for the contract's schema to be checked against. Such
 * request bodies are dropped — for routing only — so validation does not refuse them.
 */
export function withoutMultipartBodies<T extends { paths?: Record<string, unknown> }>(spec: T): T {
  const paths = Object.fromEntries(
    Object.entries(spec.paths ?? {}).map(([route, item]) => [
      route,
      Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([method, operation]) => {
          const body = (operation as { requestBody?: { content?: Record<string, unknown> } } | null)?.requestBody;
          if (!body?.content?.["multipart/form-data"]) return [method, operation];
          const { requestBody: _dropped, ...rest } = operation as Record<string, unknown>;
          return [method, rest];
        }),
      ),
    ]),
  );
  return { ...spec, paths };
}

/** The configured file, else the copy the build puts next to the bundle, else the repository's. */
function contractFile(configured: string | undefined): string {
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), "openapi.yaml");
  return configured ?? (existsSync(bundled) ? bundled : CONTRACT_FILE);
}

export async function registerContract(app: FastifyInstance, handlers: Record<string, Handler>): Promise<void> {
  const specification = withoutMultipartBodies(
    routablePaths(
      normalizeNullable(parse(readFileSync(contractFile(app.ctx.config.CONTRACT_FILE), "utf8"))) as {
        paths?: Record<string, unknown>;
      },
    ),
  );

  await app.register(openapiGlue, {
    specification,
    operationResolver: (operationId: string) =>
      handlers[operationId] ??
      (async (_req, reply) =>
        reply.code(501).send(errorBody("not_implemented", `${operationId} is not implemented yet`))),
    securityHandlers: {
      /** Verifies the access token; which organization the caller acts in is resolved per request. */
      async bearerAuth(req: FastifyRequest) {
        try {
          const payload = await req.jwtVerify<{ sub?: string; typ?: string }>();
          if (payload.typ !== "access" || !payload.sub) throw new Error("wrong token type");
          req.userId = payload.sub;
        } catch {
          throw unauthorized("access token is missing, invalid, or expired");
        }
      },
    },
  });
}
