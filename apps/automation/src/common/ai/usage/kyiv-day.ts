const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' });

/** The Europe/Kyiv calendar day of `at` as YYYY-MM-DD (every spend day in spec 029 is a Kyiv day). */
export function kyivDay(at: Date = new Date()): string {
  return fmt.format(at);
}
