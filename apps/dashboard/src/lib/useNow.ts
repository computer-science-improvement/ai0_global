import { useEffect, useState } from 'react';

/** Re-renders every `ms` so "12 s ago" and a now-line on a timeline stay true. Moved from the map's HUD (spec 078 B1). */
export function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
