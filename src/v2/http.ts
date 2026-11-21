// Requests to client API v2. Each request stands alone: the sign-in cookie
// authorizes it, writes carry an Idempotency-Key, and every failure is turned
// into one shape (status, token, Request-Id) and recorded in the error log.

import { parse, stringify } from '../relay/json';
import type { ErrorLog } from './errorLog';
import { ERROR_TOKENS, type ErrorToken } from './wire';

export interface ApiDeps {
  /** Path of the API on this origin, for example `/v2`. */
  base: string;
  fetch: typeof fetch;
  log: ErrorLog;
}

/** A response arrived and it was not a success. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly token: ErrorToken | 'unknown',
    readonly requestId: string | null,
    readonly retryable: boolean,
    /** From Retry-After, on a 503. */
    readonly retryAfterMs: number | null,
    readonly field: string | null,
  ) {
    super(`${status} ${token}`);
  }
}

/** No response: a timeout, a dropped connection or a network error. The outcome is unknown. */
export class NetworkError extends Error {}

export interface Response2 {
  status: number;
  body: unknown;
  requestId: string | null;
  /** Idempotent-Replayed: true. The stored response of an earlier send with this key. */
  replayed: boolean;
}

export interface CallOptions {
  /** For the error log: what the request is for. */
  op: string;
  method?: 'GET' | 'POST' | 'PUT';
  /** A JSON body, or raw bytes for POST /v2/files. */
  json?: unknown;
  bytes?: Blob;
  idempotencyKey?: string;
  /** For POST /v2/files: the file's name, sent as Content-Disposition. */
  fileName?: string;
}

/** RFC 5987 ext-value: UTF-8, percent-encoded outside attr-char. */
export function contentDisposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}

function retryAfter(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (v === null || !/^[0-9]+$/.test(v.trim())) return null;
  return Number(v.trim()) * 1000;
}

export async function call(deps: ApiDeps, path: string, o: CallOptions): Promise<Response2> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (o.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = stringify(o.json);
  } else if (o.bytes) {
    headers['content-type'] = o.bytes.type || 'application/octet-stream';
    if (o.fileName !== undefined) headers['content-disposition'] = contentDisposition(o.fileName);
    body = o.bytes;
  }
  if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
  let res: Response;
  try {
    res = await deps.fetch(`${deps.base}${path}`, {
      method: o.method ?? 'GET',
      credentials: 'same-origin',
      // A signed-out browser gets 401 JSON, never a redirect; a redirect is
      // read as the sign-in having ended.
      redirect: 'manual',
      cache: 'no-store',
      headers,
      body,
    });
  } catch {
    deps.log.record({ op: o.op, status: null, token: 'network', requestId: null });
    throw new NetworkError(o.op);
  }
  const requestId = res.headers.get('request-id');
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    deps.log.record({ op: o.op, status: res.status || null, token: 'unauthorized', requestId });
    throw new ApiError(401, 'unauthorized', requestId, false, null, null);
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    deps.log.record({ op: o.op, status: res.status, token: 'network', requestId });
    throw new NetworkError(o.op);
  }
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = parse(text);
    } catch {
      parsed = null;
    }
  }
  if (res.ok) {
    return { status: res.status, body: parsed, requestId, replayed: res.headers.get('idempotent-replayed') === 'true' };
  }
  const e = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const token = ERROR_TOKENS.includes(e.error as ErrorToken) ? (e.error as ErrorToken) : 'unknown';
  const id = requestId ?? (typeof e.request_id === 'string' ? e.request_id : null);
  deps.log.record({ op: o.op, status: res.status, token, requestId: id });
  // A 5xx with no contract body comes from something in front of the Server
  // (a proxy while it restarts): treated like no response, retried.
  const retryable = typeof e.retryable === 'boolean' ? e.retryable : res.status >= 500;
  throw new ApiError(res.status, token, id, retryable, retryAfter(res), typeof e.field === 'string' ? e.field : null);
}

/** A fresh UUIDv4 for an Idempotency-Key, minted once at the person's intent. */
export function newKey(): string {
  return crypto.randomUUID();
}

/** The path segment for an opaque id. */
export function seg(id: string): string {
  return encodeURIComponent(id);
}
