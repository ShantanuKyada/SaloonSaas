import type { ApiErrorBody, ErrorCode, PageMeta } from '@salon/shared';

// Single place that talks to the API: attaches the access token, silently renews it from the refresh cookie when it
// expires, and turns every failure into an ApiError with a message that is safe to show to a receptionist.

export class ApiError extends Error {
  readonly status: number;
  readonly errorCode: ErrorCode | 'NETWORK';
  readonly details: Record<string, unknown>;
  readonly requestId?: string;
  constructor(status: number, errorCode: ErrorCode | 'NETWORK', message: string, details: Record<string, unknown> = {}, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
    this.requestId = requestId;
  }
  /** Field-level problems from validation, keyed by field path. */
  get fieldErrors(): Record<string, string> {
    const issues = (this.details.issues as Array<{ path: string; message: string }> | undefined) ?? [];
    return Object.fromEntries(issues.map((i) => [i.path, i.message]));
  }
}

const BASE = '/api/v1';
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};
export const getAccessToken = () => accessToken;
/** Called when the session can no longer be renewed (signed out elsewhere, disabled, expired). */
export const onSessionLost = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const staleListeners = new Set<() => void>();
/** Called when the server shows the signed-in user's situation changed under them (two-step sign-in became required). */
export const onUserStale = (fn: () => void) => {
  staleListeners.add(fn);
  return () => staleListeners.delete(fn);
};

export interface RefreshResult {
  accessToken: string;
  expiresIn: number;
  user: unknown;
}
let onRefreshed: ((r: RefreshResult) => void) | null = null;
export const setRefreshHandler = (fn: (r: RefreshResult) => void) => {
  onRefreshed = fn;
};

export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'salonos' } });
      if (!res.ok) return false;
      const json = (await res.json()) as { data: RefreshResult };
      accessToken = json.data.accessToken;
      onRefreshed?.(json.data);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined | string[]>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Return the raw Response (downloads). */
  raw?: boolean;
  noRefresh?: boolean;
}

function toQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','));
    } else params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

async function send(method: string, path: string, opts: RequestOptions): Promise<Response> {
  // Cookie-authenticated endpoints (refresh, logout) require this header, which cross-site pages cannot send.
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'salonos' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  try {
    return await fetch(`${BASE}${path}${toQuery(opts.query)}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), credentials: 'include', signal: opts.signal });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK', 'We could not reach the server. Check your internet connection and try again.');
  }
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<{ data: T; meta?: PageMeta }> {
  let res = await send(method, path, opts);
  if (res.status === 401 && !opts.noRefresh && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await send(method, path, opts);
    else {
      listeners.forEach((fn) => fn());
    }
  }
  if (opts.raw) return { data: res as unknown as T };
  if (res.status === 204) return { data: undefined as T };
  let json: { success: boolean; data?: T; meta?: PageMeta } & Partial<ApiErrorBody>;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(res.status, 'INTERNAL_ERROR', 'The server sent an unexpected response. Please try again.');
  }
  if (!res.ok || json.success === false) {
    // An owner switched the policy on while this person was working: reload who they are so the app moves them to the set-up screen.
    if (json.errorCode === 'MFA_SETUP_REQUIRED') staleListeners.forEach((fn) => fn());
    throw new ApiError(res.status, (json.errorCode as ErrorCode) ?? 'INTERNAL_ERROR', json.message ?? 'Something went wrong. Please try again.', json.details ?? {}, json.requestId);
  }
  return { data: json.data as T, meta: json.meta };
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => request<T>('GET', path, { query, signal }).then((r) => r.data),
  list: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => request<T[]>('GET', path, { query, signal }).then((r) => ({ rows: r.data, meta: r.meta! })),
  post: <T>(path: string, body?: unknown, opts: Pick<RequestOptions, 'idempotencyKey'> = {}) => request<T>('POST', path, { body: body ?? {}, ...opts }).then((r) => r.data),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }).then((r) => r.data),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }).then((r) => r.data),
  delete: <T = void>(path: string, body?: unknown) => request<T>('DELETE', path, { body }).then((r) => r.data),
  /** Saves a CSV export (or any file) the server returns. */
  async download(path: string, query?: RequestOptions['query'], fallbackName = 'export.csv'): Promise<void> {
    const { data: res } = await request<Response>('GET', path, { query, raw: true });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new ApiError(res.status, json?.errorCode ?? 'INTERNAL_ERROR', json?.message ?? 'The export could not be created.', json?.details ?? {});
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

/** Public (signed-out) endpoints such as online booking. */
export const publicApi = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>('GET', path, { query, noRefresh: true }).then((r) => r.data),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body: body ?? {}, noRefresh: true }).then((r) => r.data),
};

export const newIdempotencyKey = () => crypto.randomUUID();
