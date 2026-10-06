// Spec 027: React glue for the nav registry.
import type { Crumb } from '../components/ui/Crumbs';
import { buildCrumbs } from './crumbs';
import { useNavLabels } from './store';

/**
 * Breadcrumbs for page `id`: its registry ancestors (with the owner's renamed
 * labels), then `extra` (dynamic ancestors). Pass the result to
 * `<PageHeader crumbs>` or `<Crumbs>`.
 */
export function useCrumbs(id: string, ...extra: Crumb[]): Crumb[] {
  const labels = useNavLabels();
  return buildCrumbs(id, extra, (e) => labels[e.id] ?? e.label);
}
