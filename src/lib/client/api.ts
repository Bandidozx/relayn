"use client";

/**
 * Browser-side fetch wrapper for the dashboard API.
 *
 * Attaches the double-submit CSRF header from the readable `relayn_csrf` cookie and
 * normalises the `{ error: { code, message, details } }` envelope into a thrown
 * `ApiClientError`, so every caller can `try/catch` and surface a toast.
 */

export const CSRF_COOKIE = "relayn_csrf";
export const CSRF_HEADER = "x-csrf-token";

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiClientError";
  }

  /** Field-level messages for inline form errors. */
  fieldError(field: string): string | undefined {
    return this.details?.[field];
  }
}

export function readCookie(name: string): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };

  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers[CSRF_HEADER] = token;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiClientError(0, "network_error", "Could not reach the server. Check your connection.");
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const envelope = (payload as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
    const details =
      envelope?.details && typeof envelope.details === "object"
        ? (envelope.details as Record<string, string>)
        : undefined;
    throw new ApiClientError(
      response.status,
      envelope?.code ?? "request_failed",
      envelope?.message ?? `Request failed with status ${response.status}.`,
      details,
    );
  }

  return payload as T;
}

/** Convenience wrappers so call sites read as intent, not plumbing. */
export const api = {
  get: <T>(path: string, signal?: AbortSignal) =>
    apiFetch<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PUT", body }),
  delete: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "DELETE", body }),
};
