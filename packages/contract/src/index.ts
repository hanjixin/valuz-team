/**
 * The HTTP contract as types. `generated/schema.d.ts` is generated from api/openapi.yaml
 * (`pnpm contract:generate`) — never edit it by hand; change the contract.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { components, operations } from "./generated/schema.d.ts";

export type { components, operations, paths } from "./generated/schema.d.ts";

/** A named schema from the contract, e.g. `Schema<"Me">`. */
export type Schema<Name extends keyof components["schemas"]> = components["schemas"][Name];

/** Every operationId in the contract. */
export type OperationId = keyof operations;

/** Where the contract file lives in the repository (the server can be pointed elsewhere when bundled). */
export const CONTRACT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../api/openapi.yaml");
