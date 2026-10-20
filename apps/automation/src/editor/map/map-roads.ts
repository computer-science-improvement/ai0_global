import type { PairLink, RawTraffic, RawTrafficRow } from './map.queries';
import type { MapNetworkMode, MapRoad } from './map.types';

/**
 * Spec 058: the roads of the map are the network's current links, not 30 days of history.
 *
 * - Copy roads: the network's anchor → every other member (kind `duplicate` in a legacy network, `adapt` in an independent
 *   one), with the published copies of the last 30 days while both are members. A new member has a road with no traffic.
 * - Promo roads: every pair the owner linked (or an approved promo linked), one road per unordered pair. `from` is the
 *   side that promoted more (ties: the smaller ref); kind `repost` when all its traffic is reposts.
 * - Past roads (`past: true`): activity of the last 30 days between two resources that are no longer linked. The map
 *   draws them only on request.
 */

export interface RoadNetwork { id: string; anchorRef: string | null; mode: MapNetworkMode }
export interface RoadInput {
  /** The connected resources and the network each is in. */
  resources: Array<{ ref: string; groupId: string | null }>;
  networks: RoadNetwork[];
  traffic: RawTraffic;
  links: PairLink[];
  /** Subscribers that joined through tracked links, `source>target`. */
  joins: Map<string, number>;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const later = (a: Date | null, b: Date | null): Date | null => (!a ? b : !b ? a : b > a ? b : a);
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function buildRoads(input: RoadInput): MapRoad[] {
  const groupOf = new Map(input.resources.map((r) => [r.ref, r.groupId]));
  const known = (ref: string) => groupOf.has(ref);
  const roads: MapRoad[] = [];

  // ── copy roads ──
  const usedDerived = new Set<number>();
  const derived = input.traffic.derived;
  for (const n of input.networks) {
    if (!n.anchorRef || !known(n.anchorRef)) continue;
    for (const r of input.resources) {
      if (r.groupId !== n.id || r.ref === n.anchorRef) continue;
      let count = 0;
      let lastAt: Date | null = null;
      derived.forEach((d, i) => {
        // copies between two current members of this network, filed under the member that is not the anchor
        if (groupOf.get(d.from) !== n.id || groupOf.get(d.to) !== n.id) return;
        const other = d.to === n.anchorRef ? d.from : d.to;
        if (other !== r.ref) return;
        count += d.count;
        lastAt = later(lastAt, d.lastAt);
        usedDerived.add(i);
      });
      roads.push({
        from: n.anchorRef, to: r.ref, kind: n.mode === 'legacy_duplicate' ? 'duplicate' : 'adapt', count30d: count, lastAt: iso(lastAt),
        joins30d: null, relation: 'network', past: false, linkedAt: null, blocked: false,
      });
    }
  }
  // copies of the last 30 days between resources that are not in one network any more
  const past = new Map<string, MapRoad & { _last: Date | null }>();
  derived.forEach((d, i) => {
    if (usedDerived.has(i) || !known(d.from) || !known(d.to)) return;
    if (groupOf.get(d.from) && groupOf.get(d.from) === groupOf.get(d.to)) return; // same network, but no anchor to draw from
    const k = `${d.from}>${d.to}>${d.kind}`;
    const cur = past.get(k);
    if (cur) { cur.count30d += d.count; cur._last = later(cur._last, d.lastAt); cur.lastAt = iso(cur._last); }
    else past.set(k, { from: d.from, to: d.to, kind: d.kind, count30d: d.count, lastAt: iso(d.lastAt), _last: d.lastAt, joins30d: null, relation: 'network', past: true, linkedAt: null, blocked: false });
  });
  for (const { _last, ...road } of past.values()) roads.push(road);

  // ── promo roads ──
  type Side = { promo: number; reposts: number; last: Date | null };
  const sides = new Map<string, Side>(); // `${from}>${to}`
  const side = (row: RawTrafficRow): Side => {
    const k = `${row.from}>${row.to}`;
    let s = sides.get(k);
    if (!s) { s = { promo: 0, reposts: 0, last: null }; sides.set(k, s); }
    return s;
  };
  for (const r of input.traffic.promo) { const s = side(r); s.promo += r.count; s.last = later(s.last, r.lastAt); }
  for (const r of input.traffic.reposts) { const s = side(r); s.reposts += r.count; s.last = later(s.last, r.lastAt); }
  const linkOf = new Map(input.links.map((l) => [pairKey(l.a, l.b), l]));
  const pairs = new Set<string>(input.links.filter((l) => l.linkedAt).map((l) => pairKey(l.a, l.b)));
  for (const k of sides.keys()) { const [f, t] = k.split('>'); pairs.add(pairKey(f, t)); }

  for (const key of pairs) {
    const [a, b] = key.split('|');
    if (a === b || !known(a) || !known(b)) continue;
    const ab = sides.get(`${a}>${b}`), ba = sides.get(`${b}>${a}`);
    // promo_pairs counts every scheduled promo (reposts too); the published reposts are read from the slots
    const promo = (ab?.promo ?? 0) + (ba?.promo ?? 0);
    const reposts = (ab?.reposts ?? 0) + (ba?.reposts ?? 0);
    const count = Math.max(promo, reposts);
    const weight = (s: Side | undefined) => Math.max(s?.promo ?? 0, s?.reposts ?? 0);
    const from = weight(ba) > weight(ab) ? b : a;
    const to = from === a ? b : a;
    const link = linkOf.get(key);
    const linked = !!link?.linkedAt && !link.blocked;
    if (!linked && count === 0) continue;
    roads.push({
      from, to, kind: reposts > 0 && reposts >= count ? 'repost' : 'promo', count30d: count, lastAt: iso(later(ab?.last ?? null, ba?.last ?? null)),
      joins30d: input.joins.has(`${a}>${b}`) || input.joins.has(`${b}>${a}`) ? (input.joins.get(`${a}>${b}`) ?? 0) + (input.joins.get(`${b}>${a}`) ?? 0) : null,
      relation: 'promo', past: !linked, linkedAt: linked ? iso(link!.linkedAt) : null, blocked: !linked && !!link?.blocked,
    });
  }

  return roads.sort((x, y) => Number(x.past) - Number(y.past) || y.count30d - x.count30d || (x.from + x.to + x.kind).localeCompare(y.from + y.to + y.kind));
}
