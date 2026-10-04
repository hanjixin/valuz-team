/** Errors that map to an HTTP status and the contract's `ApiError` body. */
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
export const forbidden = (message = "you do not have permission to do this", code = "forbidden") =>
  new HttpError(403, code, message);
export const notFound = (what = "resource") => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);

/**
 * The wire shape of every error. `detail` repeats the message under the key the
 * web client reads (it was written against FastAPI's error body).
 */
export const errorBody = (code: string, message: string) => ({ code, message, detail: message });
