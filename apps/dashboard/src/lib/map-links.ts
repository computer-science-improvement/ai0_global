import type { MapPlatform, MapResource, MapRoad, MapSnapshot } from '../api/map';
import { PLATFORM_SECTION_NAME } from './map-layout';
import { resourceTitle } from './map-state';

// Spec 058: what the map says about links — which resources are linked, which were stopped, how the "Link resources…"
// picker is grouped and what it sends. Pure functions (type-only imports), so node tests can import it.

/** At most this many resources per links call (the server refuses more). */
export const LINK_LIMIT = 30;

/** What a break means, for the confirm dialogs. */
export const UNLINK_HELP = 'The line disappears; planned promos of the pair are skipped; the manager will not propose the pair again until you link it again.';

/** " · 2 planned promos skipped", for a toast; empty when nothing was skipped. */
export const plannedPromos = (n: number): string => (n > 0 ? ` · ${n} planned ${n === 1 ? 'promo' : 'promos'} skipped` : '');

/** A road that is a link now. Roads from a server older than spec 058 have no `past` and count as current. */
export const isCurrentRoad = (r: Pick<MapRoad, 'past'>): boolean => !r.past;

/** The roads the map draws: the current links, plus the past ones when the owner asks for them. */
export function visibleRoads(roads: readonly MapRoad[], showPast: boolean): MapRoad[] {
  return showPast ? [...roads] : roads.filter(isCurrentRoad);
}

/** Past roads of the last 30 days (for the HUD toggle's count). */
export const pastRoadCount = (roads: readonly MapRoad[]): number => roads.filter((r) => r.past).length;

const isPromo = (r: MapRoad): boolean => (r.relation ?? 'promo') === 'promo' && r.kind !== 'duplicate' && r.kind !== 'adapt';
const other = (r: MapRoad, ref: string): string => (r.from === ref ? r.to : r.from);
const touches = (r: MapRoad, ref: string): boolean => r.from === ref || r.to === ref;

/** The resources a resource is linked with for promos (current promo roads, either direction). */
export function promoPartners(snap: Pick<MapSnapshot, 'roads' | 'resources'>, ref: string): MapResource[] {
  const refs = new Set(snap.roads.filter((r) => isPromo(r) && isCurrentRoad(r) && touches(r, ref)).map((r) => other(r, ref)));
  return snap.resources.filter((r) => refs.has(r.ref)).sort((a, b) => resourceTitle(a).localeCompare(resourceTitle(b)));
}

/** The refs whose promo link with this resource the owner broke (a past road marked blocked). */
export function stoppedPartners(snap: Pick<MapSnapshot, 'roads'>, ref: string): Set<string> {
  return new Set(snap.roads.filter((r) => isPromo(r) && r.past && r.blocked && touches(r, ref)).map((r) => other(r, ref)));
}

/** The other members of the resource's network (the targets of its copy links when it is the anchor, else its source). */
export function networkMates(snap: Pick<MapSnapshot, 'resources'>, res: Pick<MapResource, 'ref' | 'groupId'>): MapResource[] {
  if (!res.groupId) return [];
  return snap.resources.filter((r) => r.groupId === res.groupId && r.ref !== res.ref).sort((a, b) => resourceTitle(a).localeCompare(resourceTitle(b)));
}

/** What an Apply sends: the refs checked now that were not linked, and the refs linked that are unchecked now. */
export function linkDiff(initial: ReadonlySet<string>, checked: ReadonlySet<string>): { add: string[]; remove: string[] } {
  return {
    add: [...checked].filter((r) => !initial.has(r)).sort(),
    remove: [...initial].filter((r) => !checked.has(r)).sort(),
  };
}

/** "3 to link, 1 to unlink". */
export function diffLine(add: number, remove: number): string {
  if (!add && !remove) return 'No changes';
  return [add ? `${add} to link` : '', remove ? `${remove} to unlink` : ''].filter(Boolean).join(', ');
}

export interface LinkCandidate { res: MapResource; networkName: string | null; linked: boolean; stopped: boolean }
export interface LinkSection { id: string; title: string; items: LinkCandidate[] }

const PLATFORM_ORDER = Object.keys(PLATFORM_SECTION_NAME) as MapPlatform[];

/**
 * The picker's rows: every other resource, grouped by network first (A–Z), then by platform section for the resources in
 * no network. `query` filters on title, @username, ref and network name.
 */
export function linkSections(snap: Pick<MapSnapshot, 'resources' | 'networks' | 'roads'>, ref: string, query = ''): LinkSection[] {
  const q = query.trim().toLowerCase();
  const linked = new Set(promoPartners({ roads: snap.roads, resources: snap.resources }, ref).map((r) => r.ref));
  const stopped = stoppedPartners(snap, ref);
  const netName = new Map(snap.networks.map((n) => [n.id, n.name]));
  const candidates: LinkCandidate[] = snap.resources.filter((r) => r.ref !== ref).map((res) => ({
    res, networkName: res.groupId ? netName.get(res.groupId) ?? null : null, linked: linked.has(res.ref), stopped: stopped.has(res.ref),
  })).filter((c) => !q || [resourceTitle(c.res), c.res.username ?? '', c.res.ref, c.networkName ?? ''].some((s) => s.toLowerCase().includes(q)));
  const byTitle = (a: LinkCandidate, b: LinkCandidate) => resourceTitle(a.res).localeCompare(resourceTitle(b.res));

  const sections: LinkSection[] = [];
  for (const n of [...snap.networks].sort((a, b) => a.name.localeCompare(b.name))) {
    const items = candidates.filter((c) => c.res.groupId === n.id).sort(byTitle);
    if (items.length) sections.push({ id: `network:${n.id}`, title: n.name, items });
  }
  for (const p of PLATFORM_ORDER) {
    const items = candidates.filter((c) => !c.networkName && c.res.platform === p).sort(byTitle);
    if (items.length) sections.push({ id: `platform:${p}`, title: PLATFORM_SECTION_NAME[p], items });
  }
  return sections;
}
