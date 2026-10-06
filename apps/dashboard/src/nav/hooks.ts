// Spec 027: React glue for the nav registry.
import type { Crumb } from '../components/ui/Crumbs';
import { buildCrumbs } from './crumbs';

/** Owner renames by item id (wired to the saved menu in T4). */
function useNavLabels(): Record<string, string> {
  return {};
}

/**
 * Breadcrumbs for page `id`: its registry ancestors, then `extra` (dynamic
 * ancestors). Pass the result to `<PageHeader crumbs>` or `<Crumbs>`.
 */
export function useCrumbs(id: string, ...extra: Crumb[]): Crumb[] {
  const labels = useNavLabels();
  return buildCrumbs(id, extra, (e) => labels[e.id] ?? e.label);
}
