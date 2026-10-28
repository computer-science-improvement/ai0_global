// Spec 078 B4: the Calendar page. (Spec 027 had a redirect to /app/scheduled here; /app/scheduled itself still works.)
// Search: `from` (first day of the 5-day window), and the composer drawer's `compose`, `channel`, `day`, `post`
// (lib/calendar.ts `parseCalendarSearch` drops what is not valid, so a stale or typed link still opens the page).

import { createFileRoute } from '@tanstack/react-router';
import { CalendarPage } from '../components/calendar/CalendarPage';
import { parseCalendarSearch } from '../lib/calendar';

export const Route = createFileRoute('/app/calendar')({
  validateSearch: parseCalendarSearch,
  component: CalendarRoute,
});

function CalendarRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <CalendarPage
      search={search}
      setSearch={(patch) => void navigate({ search: (old) => ({ ...old, ...patch }) })}
    />
  );
}
