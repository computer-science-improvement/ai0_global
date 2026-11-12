// Spec 103: plain-English words for Settings → Connectors and the consent page. Pure, so a node test pins the copy.

export const SCOPE_LABEL: Record<string, string> = {
  'mcp:read': 'See channels, schedules, logs and problems, and read agent chats',
  'mcp:write': 'Plan and prepare posts (locked from agent edits), and talk to your agents',
};

export const scopeLabel = (scope: string): string => SCOPE_LABEL[scope] ?? scope;

/** Short chip text for a scope. */
export function scopeChip(scope: string): string {
  if (scope === 'mcp:read') return 'read';
  if (scope === 'mcp:write') return 'write';
  return scope;
}

export const claudeCodeCommand = (url: string): string => `claude mcp add --transport http ai0 ${url}`;

export interface StatusLike { enabled: boolean; configured: boolean; httpsOk: boolean; url: string }

/** The warning under the connector URL, or null when everything is fine. */
export function statusWarning(s: StatusLike): { tone: 'danger' | 'warning'; text: string } | null {
  if (!s.configured) {
    return { tone: 'danger', text: 'No public address is set. Set the dashboard URL (or the connector public URL) in Configuration, then turn the connector on.' };
  }
  if (!s.httpsOk) {
    return { tone: 'danger', text: 'Claude only connects to https addresses. Set an https dashboard URL or connector public URL in Configuration.' };
  }
  if (!s.enabled) {
    return { tone: 'warning', text: 'The connector is off: the URL answers 404 and nothing can connect. Turn it on to use it.' };
  }
  return null;
}

const EVENT_LABEL: Record<string, string> = {
  tool_call: 'Tool call',
  'tools/call': 'Tool call',
  register: 'App registered',
  consent_allow: 'Access allowed',
  consent_deny: 'Access denied',
  token_issued: 'Signed in',
  refresh_reuse: 'Token reuse blocked',
  revoked: 'Access revoked',
};

export const activityLabel = (event: string): string => EVENT_LABEL[event] ?? event;

/** True when the owner should look at the row (a refused reuse, a denied consent or a failed call). */
export const activityAlert = (a: { event: string; ok: boolean }): boolean => !a.ok || a.event === 'refresh_reuse';

/** The host of a URL, for display; a string that is not a URL comes back as it is. */
export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * Where the consent page sends the browser after a decision: the server's redirect, but only if it is an http(s) URL
 * (never `javascript:` or `data:`), and a loopback http URL only when the request said the app runs on this computer.
 */
export function safeRedirect(url: unknown, loopbackOk: boolean): string | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol === 'https:') return u.toString();
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  return u.protocol === 'http:' && local && loopbackOk ? u.toString() : null;
}

export type ConsentFailure = 'unknown' | 'expired' | 'decided' | 'denied' | 'error';

/** What a failed consent call means for the owner, from the HTTP status and the server's `{error}` code. */
export function consentFailure(status: number, body: string): ConsentFailure {
  let code = '';
  try { const j = JSON.parse(body) as { error?: unknown }; if (typeof j.error === 'string') code = j.error; } catch { /* not JSON */ }
  if (status === 404) return 'unknown';
  if (status === 410) return /decid|used|already/i.test(code) ? 'decided' : 'expired';
  if (status === 403) return 'denied';
  return 'error';
}

export const CONSENT_FAILURE_TEXT: Record<ConsentFailure, { title: string; text: string }> = {
  unknown: { title: 'Request not found', text: 'This sign-in request does not exist. Start again from Claude (Connect).' },
  expired: { title: 'Request expired', text: 'This sign-in request timed out. Start again from Claude (Connect).' },
  decided: { title: 'Already decided', text: 'This request was already answered. You can close this tab.' },
  denied: { title: 'Not allowed from here', text: 'Only a signed-in dashboard session can approve a connection. Sign in to the dashboard and try again.' },
  error: { title: "Couldn't load the request", text: 'Something went wrong on the server. Try again, or start again from Claude.' },
};
