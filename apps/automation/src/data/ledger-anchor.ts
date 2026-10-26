/**
 * Reference documents in the content ledger (spec 061 FR-002, migration 094).
 *
 * A law (zakon.rada.gov.ua/laws/show/1306-2001-п) is the source of many posts, one clause each; keyed by URL it was spent
 * after the first. A source on a *reusable host* (setting LEDGER_REUSABLE_HOSTS) is keyed by URL plus anchor instead: the
 * same clause is not posted twice, different clauses are allowed, and a source without an anchor is not stopped by the
 * ledger at all (story and topic dedup of spec 037 still apply).
 *
 * The anchor travels as the #fragment of the ref string (`https://zakon.rada.gov.ua/laws/show/1306-2001-п#п.1.10`), so every
 * ledger caller that passes a ref keeps passing a ref. Only reusable hosts act on it; for any other host the fragment is
 * dropped by the canonical form, as before.
 */

export const DEFAULT_REUSABLE_HOSTS = ['zakon.rada.gov.ua'];
/** The longest anchor the post spec and the ledger keep. */
export const ANCHOR_MAX = 40;

/** The host of an http(s) URL without `www.` (null for anything else). */
export function refHost(url: string): string | null {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

/** LEDGER_REUSABLE_HOSTS as a host list: the comma list of the setting, else the default. Read on every use (live setting). */
export function reusableHosts(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.LEDGER_REUSABLE_HOSTS;
  if (raw === undefined || !raw.trim()) return [...DEFAULT_REUSABLE_HOSTS];
  return raw.split(',').map((h) => h.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean);
}

/** Is the URL on a reusable host (the host itself or one of its subdomains)? */
export function isReusableHost(url: string, hosts: readonly string[] = reusableHosts()): boolean {
  const h = refHost(url);
  return !!h && hosts.some((x) => h === x || h.endsWith(`.${x}`));
}

/** The normal form of an anchor: trimmed, spaces collapsed, lower case, at most 40 characters; null for blank. (Same as content_anchor_norm in SQL.) */
export function normalizeAnchor(a: string | null | undefined): string | null {
  const t = String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, ANCHOR_MAX).trim();
  return t || null;
}

/** The #fragment of a URL, decoded when it is percent-encoded (null when there is none). */
export function fragmentOf(url: string): string | null {
  const i = url.indexOf('#');
  if (i < 0) return null;
  const raw = url.slice(i + 1);
  if (!raw.trim()) return null;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** The anchor of a source: `source.anchor`, else the URL's #fragment, normalised. */
export function anchorOf(source: { url: string; anchor?: string | null } | null | undefined): string | null {
  if (!source) return null;
  return normalizeAnchor(source.anchor) ?? normalizeAnchor(fragmentOf(source.url));
}

/**
 * The ledger ref string of a post's source: its URL, with `source.anchor` as the fragment when the post names one.
 * Callers hand this to the ledger instead of `source.url`.
 */
export function sourceRefOf(source: { url: string; anchor?: string | null } | null | undefined): string | null {
  if (!source?.url) return null;
  const anchor = typeof source.anchor === 'string' ? source.anchor.trim() : '';
  if (!anchor) return source.url;
  return `${source.url.split('#')[0]}#${anchor}`;
}

/** A ref string split for the ledger: the URL and, on a reusable host, its anchor. */
export function splitRef(ref: string, hosts: readonly string[] = reusableHosts()): { url: string; anchor: string | null; reusable: boolean } {
  const reusable = isReusableHost(ref, hosts);
  const url = ref.split('#')[0];
  return { url, anchor: reusable ? normalizeAnchor(fragmentOf(ref)) : null, reusable };
}

/** What the executor and the chat hear when the source is spent (Ukrainian, with the remedy). */
export function sourceUsedDetails(url: string, hit: { at?: Date | null; slotId?: string | null; status?: string; anchor?: string | null }, reusable: boolean): string {
  const bare = url.split('#')[0];
  const when = hit.at ? ` ${hit.at.toISOString().slice(0, 10)}` : '';
  const where = hit.slotId ? ` у слоті ${hit.slotId}` : '';
  const what = hit.anchor ? `${bare} (${hit.anchor})` : bare;
  // Spec 071: a row of a dataset that repeats in rounds, put aside because no post could be made from it.
  if (hit.status === 'passed') return `${what}: пропущене в цьому колі — з нього не вийшов пост; воно повернеться в наступному колі, візьміть інший рядок`;
  const used = hit.status === 'waiting' ? `джерело ${what} уже чекає на публікацію${where}` : hit.status === 'shadowed' ? `джерело ${what} уже є в тіньовому прев'ю${when}${where}` : hit.status === 'error' ? `джерело ${what} позначене як непридатне` : `джерело ${what} уже використано${when}${where}`;
  return reusable
    ? `${used}; візьміть інший пункт цього документа — вкажіть source.anchor (пункт, напр. «п.1.10») іншого пункту, або інше джерело`
    : `${used}; візьміть інше джерело або, для довідкового документа, вкажіть source.anchor (пункт)`;
}
