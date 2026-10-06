// Spec 027 FR-013: breadcrumbs from the registry `parent` chain. Pure, so the
// trail logic is unit-tested; `useCrumbs` (nav/hooks.ts) adds the owner's labels.
import type { Crumb } from '../components/ui/Crumbs';
import { NAV_REGISTRY, parentChain, type NavEntry } from './registry';

/**
 * Ancestors of page `id` (root first) as crumbs, then the `extra` crumbs (dynamic
 * ancestors such as the channel of an editor run). `labelOf` applies renames.
 */
export function buildCrumbs(
  id: string,
  extra: Crumb[] = [],
  labelOf: (e: NavEntry) => string = (e) => e.label,
  registry: ReadonlyArray<NavEntry> = NAV_REGISTRY,
): Crumb[] {
  const chain = parentChain(id, registry).map((e) => ({ label: labelOf(e), to: e.to, search: e.search }));
  return [...chain, ...extra];
}
