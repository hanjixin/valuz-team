import type { z } from "zod";

/** An error that maps to an HTTP status and the `{error: {code, message}}` body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "bad_request") => new HttpError(400, code, message);
export const unauthorized = (message = "authentication required") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "you do not have permission to do this") => new HttpError(403, "forbidden", message);
export const notFound = (what = "resource") => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);

export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw badRequest(detail, "validation_error");
  }
  return result.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** A malformed id can never match a row — answer 404 rather than a Postgres cast error. */
export function uuidParam(value: unknown, what = "resource"): string {
  if (!isUuid(value)) throw notFound(what);
  return value;
}

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "item";
