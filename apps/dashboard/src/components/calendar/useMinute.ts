import { useEffect, useState } from 'react';

/** The current time, refreshed every minute (the Calendar's "today" must turn at midnight without a reload). */
export function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
