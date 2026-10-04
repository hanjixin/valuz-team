/**
 * Backward-compatible JSON transport factory.
 *
 * API modules keep calling ``createFetchJson(() => _apiBase)`` while the shared
 * request layer owns URL building, error handling, timeouts, and optional
 * client-side caching.
 */

import { requestJson, type RequestOptions } from "./request";

export { ApiError } from "./request";
export type { RequestOptions, RequestCacheOptions } from "./request";

export function createFetchJson(getBase: () => string) {
  return async function fetchJson<T>(
    path: string,
    init?: RequestOptions,
  ): Promise<T> {
    // Caller-supplied baseUrl wins (per-request routing); module default otherwise.
    return requestJson<T>(path, { ...init, baseUrl: init?.baseUrl ?? getBase() });
  };
}
