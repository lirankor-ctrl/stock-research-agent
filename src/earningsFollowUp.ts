import { daysBetweenIso, normalizeTicker, usMarketDateIso } from "./dateUtils";
import { getNasdaqEarningsForDate, getYahooDailyCloses } from "./dataSources";
import { NasdaqEarningsRow } from "./nasdaqEarnings";
import {
  EarningsFollowUpEntry,
  EarningsFollowUpResult,
  EarningsFollowUpStatus,
} from "./types";
import { trackedCompanyName, trackedTickers } from "./universe";

// How far back we look for companies that already reported.
const LOOKBACK_DAYS = 7;

export interface EarningsFollowUpOptions {
  now: Date;
  onProgress?: (msg: string) => void;
}

// Nasdaq's calendar accepts one date per call – reuse the same cached,
// independent-of-Alpha-Vantage source as the forward-looking calendar, just
// walking backwards instead of forwards.
export async function buildEarningsFollowUp(
  opts: EarningsFollowUpOptions
): Promise<EarningsFollowUpResult> {
  const { now, onProgress = () => {} } = opts;
  const nowIso = usMarketDateIso(now);

  const rowsByDate: Array<{ dateIso: string; rows: NasdaqEarningsRow[] | null }> = [];
  for (let offset = 1; offset <= LOOKBACK_DAYS; offset++) {
    const dateIso = usMarketDateIso(new Date(now.getTime() - offset * 24 * 60 * 60 * 1000));
    const res = await getNasdaqEarningsForDate(dateIso, (m) => onProgress(`   ${m}`));
    rowsByDate.push({ dateIso, rows: res.value });
  }

  const base = deriveEarningsFollowUpFromRows(rowsByDate, { nowIso });
  if (base.entries.length === 0) return base;

  const entries: EarningsFollowUpEntry[] = [];
  for (const entry of base.entries) {
    const closesRes = await getYahooDailyCloses(entry.ticker, (m) => onProgress(`   ${m}`));
    entries.push({
      ...entry,
      priceChangeSincePct: priceChangeSince(closesRes.value, entry.daysAgo),
    });
  }

  return { entries, status: base.status };
}

// Approximates the trading-day offset from a calendar-day gap (skips
// weekends at a ~5/7 ratio) and reads the close that many trading days back
// from the most recent one. Best-effort: daily closes carry no per-entry
// date, so this is an approximation, never treated as exact.
function priceChangeSince(closes: number[] | null, daysAgo: number): number | null {
  if (!closes || closes.length < 2) return null;
  const tradingDaysAgo = Math.max(1, Math.round((daysAgo * 5) / 7));
  const idx = closes.length - 1 - tradingDaysAgo;
  if (idx < 0 || idx >= closes.length - 1) return null;
  const before = closes[idx];
  const latest = closes[closes.length - 1];
  if (!(before > 0)) return null;
  return ((latest - before) / before) * 100;
}

export function earningsFollowUpStatusMessageHebrew(status: EarningsFollowUpStatus): string {
  switch (status) {
    case "unavailable":
      return "לוח הדיווחים האחרונים אינו זמין כרגע (בעיית תקשורת עם מקור הנתונים) – לא ניתן לאשר אילו חברות דיווחו לאחרונה. הסעיף יתעדכן בריצה הבאה.";
    case "noneFound":
      return "אין דיווחי רווחים מאושרים ברשימת המעקב, בהזדמנויות המובילות או בחברות המגה-קאפ הנבחרות ב-7 הימים האחרונים.";
    case "confirmed":
      return "";
  }
}

// Pure, testable derivation from raw per-date rows – mirrors
// deriveEarningsCalendarFromRows so "unavailable" vs "noneFound" can never
// collapse into the same status here either.
export function deriveEarningsFollowUpFromRows(
  rowsByDate: Array<{ dateIso: string; rows: NasdaqEarningsRow[] | null }>,
  opts: { nowIso: string }
): EarningsFollowUpResult {
  const { nowIso } = opts;
  const tracked = new Map(trackedTickers().map((t) => [t.ticker, t.name]));

  let anySucceeded = false;
  const entries: EarningsFollowUpEntry[] = [];

  for (const { dateIso, rows } of rowsByDate) {
    if (rows === null) continue;
    anySucceeded = true;
    for (const row of rows) {
      const ticker = normalizeTicker(row.symbol ?? "");
      if (!ticker || !tracked.has(ticker)) continue;
      const daysAgo = daysBetweenIso(dateIso, nowIso);
      entries.push({
        ticker,
        name: tracked.get(ticker) ?? row.name ?? trackedCompanyName(ticker),
        reportDate: dateIso,
        daysAgo,
        timeOfDay: row.timeOfDay,
        priceChangeSincePct: null, // filled in by buildEarningsFollowUp with real price history
      });
    }
  }

  if (!anySucceeded) return { entries: [], status: "unavailable" };

  entries.sort((a, b) => a.daysAgo - b.daysAgo);
  return { entries, status: entries.length > 0 ? "confirmed" : "noneFound" };
}
