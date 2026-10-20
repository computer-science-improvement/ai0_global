import { createFileRoute } from '@tanstack/react-router';
import { MapPage } from '../components/map/MapPage';

// Network map (spec 056): the whole network as a game map — buildings for channels, units for agents, roads for
// cross-promo, a beacon where something waits for you. Everything on it is real state and links to a real page.
export const Route = createFileRoute('/app/map')({
  component: MapPage,
});
