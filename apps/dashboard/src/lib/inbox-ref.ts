// Spec 078 A3: what an Inbox note's `refType` / `refId` mean, in one pure place (no React, no api imports), so Today, the
// Inbox page and the note actions read them the same way.
//
//   refId  = <base>[|<suffix>][#<hash>]      a gated `postOnce` appends `#<8hex>`; a `resource_day` ref is `<ref>|<YYYY-MM-DD>`;
//                                            `event_not_covered` is `<storyId>|<ISO time>`
//   ref    = <platform>:<id>                 `telegram:@x`, `threads:<uuid>`, `bot:<uuid>`; the id may contain ':' (first-colon split)
//   series = <handle|channelKey>:<series>    the series name may contain ':' (first-colon split)

/** A page link a note can lead to: a TanStack route path (with `$param`s), its params and its search. */
export interface NoteLink {
  to:      string;
  params?: Record<string, string>;
  search?: Record<string, string | number | boolean | undefined>;
}

export interface ParsedRefId {
  raw:    string;
  /** The ref without the `#hash` and the `|suffix`. */
  base:   string;
  /** What follows the first `|` (a day for `resource_day`, a time for `event_not_covered`), or null. */
  suffix: string | null;
  /** The `YYYY-MM-DD` day when the suffix is one, else null. */
  day:    string | null;
  hash:   string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `refId.split('#')[0].split('|')[0]` is the base; null for an empty ref. */
export function parseRefId(refId: string | null | undefined): ParsedRefId | null {
  if (!refId) return null;
  const hashAt = refId.indexOf('#');
  const hash = hashAt >= 0 ? refId.slice(hashAt + 1) || null : null;
  const head = hashAt >= 0 ? refId.slice(0, hashAt) : refId;
  const barAt = head.indexOf('|');
  const base = barAt >= 0 ? head.slice(0, barAt) : head;
  const suffix = barAt >= 0 ? head.slice(barAt + 1) || null : null;
  if (!base) return null;
  return { raw: refId, base, suffix, day: suffix && DAY.test(suffix) ? suffix : null, hash };
}

/** `<platform>:<id>` split at the first colon (the id may hold more colons); null when it is not one. */
export function parseResourceRef(ref: string | null | undefined): { platform: string; id: string } | null {
  if (!ref) return null;
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) return null;
  return { platform: ref.slice(0, i), id: ref.slice(i + 1) };
}

/** The channel key of a `telegram:<channelKey>` resource ref or agent scope (`telegram:@x` → `@x`), else null. */
export function telegramChannelOf(ref: string | null | undefined): string | null {
  const r = parseResourceRef(ref);
  return r && r.platform === 'telegram' ? r.id : null;
}

/**
 * `series_source_empty`: `<handle|channelKey>:<series name>`, split at the first colon only. The note is posted without a
 * gate, so the ref has no `#hash`, and a series name may hold `|` or `#`: the raw ref is read, not its base.
 */
export function parseSeriesRef(refId: string | null | undefined): { owner: string; series: string } | null {
  const r = parseResourceRef(refId);
  return r ? { owner: r.platform, series: r.id } : null;
}

/** `manager_escalation`: `escalation:<handle>:<kind>|<day>#<hash>`. */
export function parseEscalationRef(refId: string | null | undefined): { handle: string; kind: string } | null {
  const m = /^escalation:([^:]+):(.+)$/.exec(parseRefId(refId)?.base ?? '');
  return m ? { handle: m[1], kind: m[2] } : null;
}

/** `host_struck`: `<channelKey>/<host>`; a host has no '/', so split at the last one. */
export function parseHostRef(refId: string | null | undefined): { channelKey: string; host: string } | null {
  const base = parseRefId(refId)?.base;
  if (!base) return null;
  const i = base.lastIndexOf('/');
  return i > 0 && i < base.length - 1 ? { channelKey: base.slice(0, i), host: base.slice(i + 1) } : null;
}

/** The first `telegram:<channelKey>` named in a text (the lines of an `event_not_covered` body), or null. */
export function firstTelegramRef(text: string | null | undefined): string | null {
  const m = /(?:^|[\s•(])telegram:(@?[A-Za-z0-9_.-]+)/.exec(text ?? '');
  return m ? `telegram:${m[1]}` : null;
}

// ── Connections page ───────────────────────────────────────────────────────

/**
 * Where a platform's connection is managed: the same mapping as the map (`map.service.ts` CONNECTION_SECTION): Facebook,
 * Instagram and Threads are tabs of the Meta section, TikTok has its own, Telegram and YouTube live in the Telegram section.
 * Bots, MTProto sessions and Telegraph accounts (`bot:` / `mtproto:` / `telegraph:` refs) are tabs of the Telegram section.
 */
export function connectionLink(platform: string): NoteLink {
  const to = '/app/connections';
  switch (platform) {
    case 'bot':       return { to, search: { section: 'telegram', tab: 'bots' } };
    case 'mtproto':   return { to, search: { section: 'telegram', tab: 'sessions' } };
    case 'telegraph': return { to, search: { section: 'telegram', tab: 'telegraph' } };
    case 'instagram': case 'facebook': case 'threads': return { to, search: { section: 'meta', tab: platform } };
    case 'tiktok':    return { to, search: { section: 'tiktok' } };
    default:          return { to, search: { section: 'telegram' } };
  }
}

// ── Agent tree ─────────────────────────────────────────────────────────────

/** The part of an agent node these helpers read (an `AgentNode` fits). */
export interface TreeNode {
  id:        string;
  handle:    string;
  name?:     string;
  kind:      string;
  scopeId:   string | null;
  mode?:     string;
  children?: readonly TreeNode[];
}

export function flattenTree(nodes: readonly TreeNode[] | null | undefined): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (ns: readonly TreeNode[]) => { for (const n of ns) { out.push(n); if (n.children?.length) walk(n.children); } };
  walk(nodes ?? []);
  return out;
}

export const nodeByHandle = (tree: readonly TreeNode[] | null | undefined, handle: string | null | undefined): TreeNode | null =>
  (handle ? flattenTree(tree).find((n) => n.handle === handle) : null) ?? null;

export const nodeById = (tree: readonly TreeNode[] | null | undefined, id: string | null | undefined): TreeNode | null =>
  (id ? flattenTree(tree).find((n) => n.id === id) : null) ?? null;

/** The agent that runs a resource (`scopeId` = the resource ref, `telegram:@x`); the orchestrator wins over its helpers. */
export function nodeByScope(tree: readonly TreeNode[] | null | undefined, scopeId: string | null | undefined): TreeNode | null {
  if (!scopeId) return null;
  const hits = flattenTree(tree).filter((n) => n.scopeId === scopeId);
  return hits.find((n) => n.kind === 'orchestrator') ?? hits[0] ?? null;
}

interface RefOwner { agentId: string | null; refType: string | null; refId: string | null }

/** The resource ref a note is about (`refType` resource / resource_day), else null. */
export function resourceRefOf(it: Pick<RefOwner, 'refType' | 'refId'>): string | null {
  return it.refType === 'resource' || it.refType === 'resource_day' ? parseRefId(it.refId)?.base ?? null : null;
}

/**
 * The agent a note belongs to. Health, connection, event and budget notes carry no `agentId`, so the ref is matched with the
 * tree: `agentId` first, then `refType: 'agent'` (refId is the handle), the escalation's agent, the resource's orchestrator
 * (`scopeId`), and the owner of a series ref. An empty tree is "not loaded": a handle named by the ref itself is trusted.
 */
export function resolveHandle(it: RefOwner, tree: readonly TreeNode[] | null | undefined): string | null {
  const known = flattenTree(tree).length > 0;
  const hasHandle = (h: string) => !known || nodeByHandle(tree, h) !== null;
  const byId = nodeById(tree, it.agentId);
  if (byId) return byId.handle;
  const base = parseRefId(it.refId)?.base ?? null;
  if (it.refType === 'agent' && base && hasHandle(base)) return base;
  if (it.refType === 'escalation') {
    const e = parseEscalationRef(it.refId);
    if (e && hasHandle(e.handle)) return e.handle;
  }
  const res = resourceRefOf(it);
  if (res) {
    const n = nodeByScope(tree, res);
    if (n) return n.handle;
  }
  if (it.refType === 'series') {
    const s = parseSeriesRef(it.refId);
    if (s && known && nodeByHandle(tree, s.owner)) return s.owner;
    if (s && !known) return s.owner;
  }
  return null;
}

/**
 * The channel key a "Replan" runs for: the note's `telegram:<key>` resource, else the Telegram scope of its agent
 * (`telegram:@x` → `@x`), else null (a note on another platform whose agent runs a network has no single channel).
 */
export function replanChannel(it: RefOwner, tree: readonly TreeNode[] | null | undefined): string | null {
  const fromRef = telegramChannelOf(resourceRefOf(it));
  if (fromRef) return fromRef;
  return telegramChannelOf(nodeById(tree, it.agentId)?.scopeId);
}
