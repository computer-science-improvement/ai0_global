import type { CardSource, EditorCard } from '../card';
import { egressProxyConfigured, proxyHosts } from '../net/safe-http';

/**
 * Spec 076 FR-008 / L7: the two fixes the doctor offers for a source finding. They are plain functions the controller calls
 * and the lead's fix runner registers at merge; neither is auto-safe (the owner presses the button). `FixResult` is the
 * contract's shape, copied here so the file imports nothing of the readiness code.
 */
export interface FixResult { ok: boolean; applied?: string; error?: string }

export interface SourceDropFix { kind: 'source_drop'; channel: string; sourceId: string }
export interface HostProxyAddFix { kind: 'host_proxy_add'; host: string }

export interface SourceDropDeps {
  /** The card as saved, or null for an unknown channel. */
  card(channelKey: string): Promise<Pick<EditorCard, 'sources'> | null>;
  /** The card save that validates (`EditorOpsService.upsertChannel`): the merged card replaces the `sources` array. */
  upsert(channelKey: string, body: { sources: CardSource[] }): Promise<unknown>;
}

const message = (err: unknown): string => {
  const r = (err as { getResponse?: () => unknown })?.getResponse?.();
  if (r && typeof r === 'object' && typeof (r as { error?: unknown }).error === 'string') return (r as { error: string }).error;
  return String((err as Error)?.message ?? err).slice(0, 300);
};

/**
 * Removes one source from a card through the card save (`channel_not_found`, `source_not_found` when there is nothing to remove).
 * `sourceId` is the card source's id; a finding built from a fact that carries no id names the source by its address instead, so
 * an address that no id has is matched against the sources' `ref`.
 */
export async function applySourceDrop(deps: SourceDropDeps, fix: SourceDropFix): Promise<FixResult> {
  const card = await deps.card(fix.channel).catch(() => null);
  if (!card) return { ok: false, error: 'channel_not_found' };
  const source = card.sources.find((s) => s.id === fix.sourceId) ?? card.sources.find((s) => s.ref === fix.sourceId);
  if (!source) return { ok: false, error: 'source_not_found' };
  try {
    await deps.upsert(fix.channel, { sources: card.sources.filter((s) => s !== source) });
  } catch (err) {
    return { ok: false, error: message(err) };
  }
  return { ok: true, applied: `Removed source “${source.id}” (${source.kind} ${source.ref}) from ${fix.channel}` };
}

export interface HostProxyAddDeps {
  env: (k: string) => string | undefined;
  /** `SettingsService.setValue('EGRESS_PROXY_HOSTS', value)`: validates the list, stores it and applies it at once. */
  setHosts(value: string): Promise<unknown>;
}

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** The hosts as the proxy setting lists them (lower-case, no leading `www.`). */
export const proxyHostList = (env: (k: string) => string | undefined): string[] => proxyHosts(env('EGRESS_PROXY_HOSTS'));

/** Adds a host to `EGRESS_PROXY_HOSTS` (`proxy_not_configured` without a usable `EGRESS_PROXY_URL`; a host already covered is left as it is). */
export async function applyHostProxyAdd(deps: HostProxyAddDeps, fix: HostProxyAddFix): Promise<FixResult> {
  if (!egressProxyConfigured(deps.env)) return { ok: false, error: 'proxy_not_configured' };
  const host = fix.host.trim().toLowerCase().replace(/^www\./, '');
  if (!HOST_RE.test(host) || host.length > 253) return { ok: false, error: 'invalid_host' };
  const current = proxyHostList(deps.env);
  if (current.some((l) => host === l || host.endsWith(`.${l}`))) return { ok: true, applied: `${host} is already read through the proxy` };
  try {
    await deps.setHosts([...current, host].join(','));
  } catch (err) {
    return { ok: false, error: message(err) };
  }
  return { ok: true, applied: `${host} is now read through the proxy` };
}
