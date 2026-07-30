// Alpha Vantage's earnings/dividend calendar dates are US market dates
// (America/New_York), not UTC. Using Date#toISOString() to get "today" can
// be off by a day around midnight UTC (e.g. 8pm ET is already the next day
// in UTC) – always derive "today" through this helper for calendar math.
const US_MARKET_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// en-CA formats as YYYY-MM-DD.
export function usMarketDateIso(date: Date): string {
  return US_MARKET_DATE_FORMATTER.format(date);
}

export function daysBetweenIso(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

export function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase();
}

export function normalizeDateIso(raw: string): string {
  return raw.trim().slice(0, 10);
}

export function isFutureOrTodayIso(dateIso: string | undefined, todayIso: string): boolean {
  if (!dateIso) return false;
  return daysBetweenIso(todayIso, normalizeDateIso(dateIso)) >= 0;
}
