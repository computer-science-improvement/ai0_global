# 058 — Map links the owner controls

Status: in progress · Follow-up of [056](../056-network-map/spec.md) · Migration 091

## Why (the owner's words, 2026-10-21)

> When I switch off the link between Telegram and Instagram or Facebook, the map still shows it. I want to really break it,
> and be able to connect other resources — a select, add several.

Today a road on `/app/map` is **activity of the last 30 days** (`MapQueries.roads()`: `promo_pairs.count_30d`, published
reposts, published derived `duplicate`/`adapt` slots). So:

- taking a resource out of a network leaves its copy road for up to 30 days (and copies already planned for it still go out);
- stopping promos only fades the road and puts a ⊘ on it;
- there is no way to *create* a link from the map except moving a resource into a network one at a time.

The owner reads the map as **the current wiring of the network**. A road must mean "this relation is on now", breaking it
must make it disappear at once, and linking must be a picker with several resources at a time.

## Model: two kinds of links

| Link | Means | Exists while | Made by | Broken by |
|---|---|---|---|---|
| **Copy link** (network) | posts of the network's channel are copied / adapted to the member (legacy auto-duplicate or the independent agent's decision) | both are in the same network | putting the resource in the network (map picker, Connections → Groups) | taking it out of the network |
| **Promo link** | the two may promote each other (cross-promo, Telegram reposts); the manager proposes promos between them, each still needs the owner's approval | `promo_pairs.linked_at` is set (both directions) | the owner on the map; or approving a cross-promo / repost directive for a not-yet-linked pair (the approval is the consent) | the owner on the map (unlink) |

### Backend

1. **Migration 091** (`091_promo_links.sql` + down): `promo_pairs.linked_at TIMESTAMPTZ`. Seed: set `linked_at = now()` on
   both directions of every pair that had a promo in the last 60 days (`last_promo_at > now() - 60 days` or
   `count_30d > 0`) and is not blocked (`blocked_at IS NULL`), so today's active pairs stay on the map.
2. **Link / unlink** — `MapActions.setLinks({ ref, add: string[], remove: string[] })` → `POST /api/map/links`
   (max 30 refs per call; each must be a connected resource ≠ ref; 404 unknown, 400 same):
   - add: upsert both directions with `linked_at = now()`, `blocked_at = NULL`;
   - remove: both directions `linked_at = NULL`, `blocked_at = now()` (an owner-broken link is not proposed again until
     re-linked), and the pending promo slots of the pair are skipped exactly like `setPairBlocked` does today (reuse it);
   - returns `{ ref, linked: string[], unlinked: string[], canceled }` and invalidates the snapshot.
   `POST /api/map/promo-block` stays for compatibility; `blocked: true` now also clears `linked_at`, `false` sets it.
3. **Network members in bulk** — `MapActions.setMembers({ groupId, add: string[], remove: string[] })` →
   `POST /api/map/network-members`: the same rules as `setGroup` per resource (one per platform per network, 409 with the
   clashing resource named, 422 not tracked), applied in order, returns per-ref results `{ ref, ok, error? }` (partial
   success allowed, nothing rolled back), invalidates once.
4. **Breaking a copy link really stops copies**: when a resource leaves a network (`setGroup` to null or another network,
   and `setMembers` remove), its pending derived slots from the old network (`derived_from_slot_id IS NOT NULL`,
   `resource_ref = ref`, status `planned | awaiting_approval | approved`) become `skipped` with
   error `'resource left the network'`; the response carries `canceled`.
5. **Planner / manager**:
   - `PromoPlanner`: a blocked pair → `pair_blocked` (as now). A linked pair skips the `low_relevance` check (the owner
     linked it on purpose). An unlinked, unblocked pair goes through as today and, once the slot is reserved, becomes
     linked (`linked_at = now()` both ways) — the owner approved the directive.
   - The manager's promo context (`PromoService` pairs list) gets `linked` and `blocked` per pair, and the cross-promo
     directive tool refuses a blocked pair at creation with `pair_blocked` (Ukrainian details like the planner's).
6. **Roads = current links** (`MapQueries.roads()` / `MapService`):
   - copy roads: the network's anchor → every other member of the same network (one per member), kind `duplicate` when
     the network mode is `legacy_duplicate`, else `adapt`; `count30d`/`lastAt` from the published derived slots of the
     last 30 days *while it is a member* (0 is fine — a new link is drawn with no traffic yet);
   - promo roads: every linked pair, one road per unordered pair (`from` = the side that promoted more, ties by ref),
     kind `promo` (or `repost` when all its traffic is reposts), counts from the last 30 days as now;
   - **past roads**: activity of the last 30 days between two resources that are no longer linked (taken out, unlinked,
     blocked) → returned with `past: true` so the map can show them on request; never drawn by default.
   - `MapRoad` gets `relation: 'network' | 'promo'`, `past: boolean`, `linkedAt: string | null`; `blocked` stays
     (true only on past promo roads the owner broke).
7. **Map events**: a link made/broken by the owner adds a feed event ("linked X ↔ Y", "unlinked X ↔ Y", "X left Network").

### Dashboard (`/app/map`)

1. Roads drawn from the new fields: current links solid (copy) / dashed (promo) as now; with no traffic yet a thin line and
   "no posts yet" in the road drawer. Past roads hidden; a HUD toggle **"Show past links"** draws them faint with a ⊘ and
   the road drawer says "Not linked any more — traffic from the last 30 days" with **Link again**.
2. **Building drawer → "Links" section** (replaces the current Network section; keep the NetworkPicker inside it):
   - *Copies*: the network line (NetworkPicker) plus the list of the network's other members as chips (click = select).
   - *Promo partners*: chips of linked resources (avatar/platform icon + title), each with an × that unlinks after a
     confirm ("The line disappears; planned promos of the pair are skipped; the manager will not propose the pair again
     until you link it again.").
   - **Link resources…** button → a Modal with a searchable multi-select checklist of every other resource, grouped by
     section (networks, then platform sections), each row: platform icon, title, network name, a "linked" / "stopped"
     badge; already-linked rows are checked (unchecking = unlink). Footer: "N to link, M to unlink" + Apply →
     `POST /api/map/links` with the diff; toast with the counts and canceled promos.
3. **Network territory drawer** (click on a territory label, or the network chip): **Members…** button → a Modal
   multi-select of resources not in a network plus the current members (checked), one per platform enforced in the UI
   (a second resource of a taken platform is disabled with "network already has <title>"); Apply →
   `POST /api/map/network-members`; per-ref errors listed in the toast/dialog. If a territory drawer does not exist yet,
   add a small one: name, mode (Independent / Auto-duplicate with the existing switch), members, agent, Members…
4. **Road drawer**: one **Break link** action that matches the road: copy road → "Take <target> out of <network>"
   (existing flow, now also says how many planned copies were skipped); promo road → "Unlink" (calls `/api/map/links`
   remove). The "Stop promos" wording goes; "Switch <network> to Independent" stays for copy roads of legacy networks.
5. **Link mode** (RPG touch, small): a HUD button "Link" (icon `link`): click a building, then another → a small popover
   at the second building: "Promo partners" / "Put <B> in <A's network>" (the second only when the platform slot is free
   and A is in a network) / Cancel. Escape leaves link mode. A hint line under the HUD while active.
6. All UI text English; `useConfirm` for every break; mutations invalidate the map snapshot and meta-account-groups.
7. Mock data (`lib/map-demo.ts`) covers: a linked pair with no traffic, a past road, a network with free platform slots.

## Not in scope

LinkedIn, YouTube, TikTok-specific work; changing how copies are written; the other map ideas (listed separately to the owner).

## Acceptance

- Unit + PG tests: migration seed, setLinks (add/remove/idempotent/limits), setMembers (partial success, conflicts),
  derived-slot skipping on leaving a network, planner (linked skips relevance; approved unlinked pair gets linked;
  blocked refused), roads = links (+ past), manager tool refuses blocked.
- Dashboard tsc/tests/build green; lead verifies in the browser on mocks: unlink → line gone; link several → lines appear;
  members modal; link mode; past toggle.
- Runbook §15 (network map) updated; specs README row 058 DONE.
