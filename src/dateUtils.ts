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

// ===== Timezone-aware local-time parts =====
//
// Node 20's official builds ship full ICU, so Intl.DateTimeFormat with an
// arbitrary IANA `timeZone` works with no extra dependency and correctly
// handles DST transitions (Israel and US switch on different dates, which is
// exactly why a single fixed UTC offset can't represent "16:05 Israel time"
// or "9:30 US market time" year-round).
export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sunday .. 6=Saturday
  minuteOfDay: number; // hour*60+minute, for simple threshold comparisons
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  // hour12:false can render midnight as "24" in some ICU versions – normalize.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const weekday = WEEKDAY_INDEX[get("weekday")] ?? 0;
  return { year, month, day, hour, minute, weekday, minuteOfDay: hour * 60 + minute };
}

export const ISRAEL_TZ = "Asia/Jerusalem";
export const US_MARKET_TZ = "America/New_York";
