import { API_BASE } from '../lib/env';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * Called on every 401 with the backend's reason code (`session_expired`, …).
 * Registered by `router.ts` (invalidate the session, one navigation to /login);
 * kept as a hook so this module never imports the router (that would be a cycle:
 * router → routes → api modules → client).
 */
let onUnauthorized: (reason: string | null) => void = () => undefined;
export function setUnauthorizedHandler(fn: (reason: string | null) => void): void { onUnauthorized = fn; }

/** Read `{code}` from a 401 body, report it, and return the ApiError to throw. */
export async function unauthorized(res: Response): Promise<ApiError> {
  let code: string | null = null;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') code = (body as { code: string }).code;
  } catch { /* empty or non-JSON body */ }
  onUnauthorized(code);
  return new ApiError(401, code ?? 'unauthorised');
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  if (res.status === 401) throw await unauthorized(res);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
