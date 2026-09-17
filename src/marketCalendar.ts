// ===== US equity market calendar (NYSE / Nasdaq) =====
//
// Derived algorithmically from the published NYSE holiday rules rather than
// kept as a hardcoded list of dates. A date list silently rots the moment it
// runs past its last entry — and it would have rotted invisibly, because the
// failure mode is "the report looks normal on a day the market never opened".
// Every rule below is a standing NYSE rule, so this stays correct in future
// years with no maintenance.
//
// This closed a real production gap: the 2026-09-07 run generated and mailed
// a full pre-market report on Labor Day, a day the US market never opened.
//
// All inputs are US market dates (America/New_York), i.e. what
// usMarketDateIso() produces — never UTC dates.

function isoToUtcNoon(dateIso: string): Date {
  // Noon avoids any chance of a date rolling over from timezone arithmetic.
  return new Date(`${dateIso}T12:00:00Z`);
}

function weekday(dateIso: string): number {
  return isoToUtcNoon(dateIso).getUTCDay(); // 0=Sun .. 6=Sat
}

function iso(year: number, month: number, day: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${year}-${p(month)}-${p(day)}`;
}

function addDays(dateIso: string, days: number): string {
  const d = isoToUtcNoon(dateIso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The nth given weekday of a month, e.g. nthWeekdayOfMonth(2026, 1, 1, 3) is
// the 3rd Monday of January 2026.
function nthWeekdayOfMonth(year: number, month: number, targetWeekday: number, n: number): string {
  const firstWeekday = weekday(iso(year, month, 1));
  const offset = (targetWeekday - firstWeekday + 7) % 7;
  return iso(year, month, 1 + offset + (n - 1) * 7);
}

function lastWeekdayOfMonth(year: number, month: number, targetWeekday: number): string {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastWeekday = weekday(iso(year, month, daysInMonth));
  const back = (lastWeekday - targetWeekday + 7) % 7;
  return iso(year, month, daysInMonth - back);
}

// NYSE observation rule for fixed-date holidays: a Saturday holiday is
// observed the preceding Friday, a Sunday holiday the following Monday.
//
// The one documented exception is New Year's Day falling on a Saturday: the
// market does NOT close on the preceding Friday, because that Friday belongs
// to the previous year. Callers pass `observeSaturday: false` for that case.
function observed(dateIso: string, observeSaturday = true): string | null {
  const wd = weekday(dateIso);
  if (wd === 6) return observeSaturday ? addDays(dateIso, -1) : null;
  if (wd === 0) return addDays(dateIso, 1);
  return dateIso;
}

// Easter Sunday (Gregorian), Meeus/Jones/Butcher algorithm. Needed only for
// Good Friday, which is the one NYSE holiday with no fixed date.
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

export interface MarketHoliday {
  date: string;
  name: string;
}

// Every full-closure NYSE holiday in a given calendar year, already adjusted
// for weekend observation.
export function usMarketHolidays(year: number): MarketHoliday[] {
  const out: MarketHoliday[] = [];
  const push = (date: string | null, name: string) => {
    if (date) out.push({ date, name });
  };

  push(observed(iso(year, 1, 1), false), "New Year's Day");
  push(nthWeekdayOfMonth(year, 1, 1, 3), "Martin Luther King Jr. Day");
  push(nthWeekdayOfMonth(year, 2, 1, 3), "Washington's Birthday");
  push(addDays(easterSunday(year), -2), "Good Friday");
  push(lastWeekdayOfMonth(year, 5, 1), "Memorial Day");
  // Juneteenth became a US federal holiday, and an NYSE closure, in 2021.
  if (year >= 2021) push(observed(iso(year, 6, 19)), "Juneteenth National Independence Day");
  push(observed(iso(year, 7, 4)), "Independence Day");
  push(nthWeekdayOfMonth(year, 9, 1, 1), "Labor Day");
  push(nthWeekdayOfMonth(year, 11, 4, 4), "Thanksgiving Day");
  push(observed(iso(year, 12, 25)), "Christmas Day");

  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function usMarketHolidayName(dateIso: string): string | null {
  const year = Number(dateIso.slice(0, 4));
  return usMarketHolidays(year).find((h) => h.date === dateIso)?.name ?? null;
}

export function isUsMarketHoliday(dateIso: string): boolean {
  return usMarketHolidayName(dateIso) !== null;
}

export function isWeekend(dateIso: string): boolean {
  const wd = weekday(dateIso);
  return wd === 0 || wd === 6;
}

export function isUsTradingDay(dateIso: string): boolean {
  return !isWeekend(dateIso) && !isUsMarketHoliday(dateIso);
}

// ===== Early closes (13:00 ET instead of 16:00 ET) =====
//
// NYSE closes early on three recurring occasions. These are half-days, NOT
// closures: the market opens normally at 09:30 ET, so a PRE-MARKET report is
// still perfectly valid — only the close time moves.
export function isUsEarlyCloseDay(dateIso: string): boolean {
  if (!isUsTradingDay(dateIso)) return false;
  const year = Number(dateIso.slice(0, 4));

  // July 3, when it is itself a trading day and July 4 is a weekday. When
  // July 4 falls on a Saturday, July 3 is the observed holiday (a full
  // closure, already excluded above) and there is no early close at all.
  const julyThird = iso(year, 7, 3);
  if (dateIso === julyThird && !isWeekend(iso(year, 7, 4))) return true;

  // The Friday after Thanksgiving.
  if (dateIso === addDays(nthWeekdayOfMonth(year, 11, 4, 4), 1)) return true;

  // Christmas Eve, when it is a trading day in its own right.
  if (dateIso === iso(year, 12, 24)) return true;

  return false;
}

export const REGULAR_CLOSE_MINUTE = 16 * 60; // 16:00 ET
export const EARLY_CLOSE_MINUTE = 13 * 60;   // 13:00 ET

export function usMarketCloseMinute(dateIso: string): number {
  return isUsEarlyCloseDay(dateIso) ? EARLY_CLOSE_MINUTE : REGULAR_CLOSE_MINUTE;
}
