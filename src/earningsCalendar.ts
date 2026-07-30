import { daysBetweenIso, normalizeTicker, usMarketDateIso } from "./dateUtils";
import { getNasdaqEarningsForDate } from "./dataSources";
import { NasdaqEarningsRow } from "./nasdaqEarnings";
import { EarningsCalendarEntry, EarningsCalendarStatus, EarningsUrgency } from "./types";
import { trackedCompanyName, trackedTickers, WATCHLIST_TICKERS } from "./universe";

const WINDOW_DAYS = 14;

// Sector hints for mega-cap names that aren't already enriched with a real
// profile (kept minimal – only used as a fallback for the "why watch" blurb).
const MEGA_CAP_SECTOR_HINT: Record<string, string> = {
  AAPL: "Consumer Electronics",
  MSFT: "Software/Cloud",
  NVDA: "Semiconductors",
  GOOGL: "Internet/Advertising",
  AMZN: "Internet/Retail/Cloud",
  META: "Internet/Advertising",
  TSLA: "Automotive",
  AVGO: "Semiconductors",
  JPM: "Banking",
  V: "Financial Services",
  UNH: "Health Insurance",
  LLY: "Pharmaceuticals",
};

// Sector/industry-keyed "why investors will watch" commentary – generic
// framing tied to the sector, never a fabricated fact about a specific
// company or quarter.
const SECTOR_WATCH_HEBREW: Array<{ match: RegExp; hebrew: string }> = [
  { match: /semiconduct|chip/i, hebrew: "ביקוש ל-AI, מלאי בשרשרת האספקה ושולי רווח גולמי" },
  { match: /software|cloud|internet/i, hebrew: "צמיחת הענן, שימור לקוחות (Retention) והכוונה (Guidance) קדימה" },
  { match: /cyber/i, hebrew: "צמיחת ARR, שימור לקוחות ותחרות בשוק אבטחת המידע" },
  { match: /auto/i, hebrew: "מסירות רכבים, שולי רווח ותחרות בשוק ה-EV" },
  { match: /advertis|media/i, hebrew: "הכנסות פרסום, מעורבות משתמשים והוצאות תוכן" },
  { match: /bank|financ|insurance/i, hebrew: "הפרשות אשראי, ריבית נטו והכנסות ממסחר" },
  { match: /retail|consumer electronics|hardware/i, hebrew: "מכירות ומלאי, ומגמות ביקוש צרכני" },
  { match: /pharma|biotech|health/i, hebrew: "תוצאות ניסויים קליניים, אישורי רגולציה וצנרת מוצרים" },
  { match: /energy|oil/i, hebrew: "מחירי אנרגיה, היקפי הפקה והוצאות הון" },
];
const DEFAULT_WATCH_HEBREW = "צמיחת הכנסות, שולי רווח והכוונה (Guidance) לרבעונים הבאים";

function sectorReasonHebrew(sector?: string, industry?: string): string {
  const haystack = `${sector ?? ""} ${industry ?? ""}`;
  const hit = SECTOR_WATCH_HEBREW.find((s) => s.match.test(haystack));
  return hit?.hebrew ?? DEFAULT_WATCH_HEBREW;
}

// Real, computed (not fabricated) YoY EPS-forecast comparison, when both
// figures are present in Nasdaq's calendar row.
function epsGrowthReasonHebrew(row: NasdaqEarningsRow): string | null {
  if (row.epsForecast === undefined || row.lastYearEPS === undefined || row.lastYearEPS === 0) {
    return null;
  }
  const growthPct = ((row.epsForecast - row.lastYearEPS) / Math.abs(row.lastYearEPS)) * 100;
  if (growthPct > 1) {
    return `אנליסטים צופים רווח למניה של $${row.epsForecast.toFixed(2)}, צמיחה של כ-${growthPct.toFixed(0)}% לעומת $${row.lastYearEPS.toFixed(2)} בתקופה המקבילה אשתקד`;
  }
  if (growthPct < -1) {
    return `אנליסטים צופים רווח למניה של $${row.epsForecast.toFixed(2)}, ירידה של כ-${Math.abs(growthPct).toFixed(0)}% לעומת $${row.lastYearEPS.toFixed(2)} בתקופה המקבילה אשתקד`;
  }
  return `אנליסטים צופים רווח למניה של $${row.epsForecast.toFixed(2)}, דומה לתקופה המקבילה אשתקד ($${row.lastYearEPS.toFixed(2)})`;
}

function reasonsHebrew(
  row: NasdaqEarningsRow,
  sector?: string,
  industry?: string
): string[] {
  const reasons: string[] = [];
  const epsReason = epsGrowthReasonHebrew(row);
  if (epsReason) reasons.push(epsReason);
  reasons.push(sectorReasonHebrew(sector, industry ?? MEGA_CAP_SECTOR_HINT[row.symbol]));
  if (row.marketCap !== undefined && row.marketCap >= 200_000_000_000) {
    reasons.push("חברת מגה-קאפ – לתוצאות שלה השפעה רחבה על סנטימנט הסקטור והשוק הרחב");
  }
  return reasons.slice(0, 3);
}

function urgencyFor(daysRemaining: number): EarningsUrgency {
  if (daysRemaining <= 0) return "today";
  if (daysRemaining === 1) return "tomorrow";
  if (daysRemaining <= 7) return "week";
  return "later";
}

export interface EarningsCalendarResult {
  entries: EarningsCalendarEntry[];
  status: EarningsCalendarStatus;
}

export interface EarningsCalendarOptions {
  now: Date;
  onProgress?: (msg: string) => void;
  // Sector/industry for tickers we already enriched this run (watchlist +
  // top opportunities) – avoids any extra work just for this section.
  enrichedByTicker: Map<string, { sector?: string; industry?: string }>;
}

// Nasdaq's public calendar only accepts a single date per call, so we query
// once per day across the window (each cached 24h – a same-day re-run only
// re-fetches dates it hasn't already seen). Independent of Alpha Vantage:
// this never touches the AV daily-call budget. Delegates the actual
// derivation to the pure `deriveEarningsCalendarFromRows` below, so the live
// path and the unit-tested path can never drift apart.
export async function buildEarningsCalendar(
  opts: EarningsCalendarOptions
): Promise<EarningsCalendarResult> {
  const { now, onProgress = () => {}, enrichedByTicker } = opts;
  const nowIso = usMarketDateIso(now);

  const rowsByDate: Array<{ dateIso: string; rows: NasdaqEarningsRow[] | null }> = [];
  for (let offset = 0; offset <= WINDOW_DAYS; offset++) {
    const dateIso = usMarketDateIso(new Date(now.getTime() + offset * 24 * 60 * 60 * 1000));
    const res = await getNasdaqEarningsForDate(dateIso, (m) => onProgress(`   ${m}`));
    rowsByDate.push({ dateIso, rows: res.value });
  }

  return deriveEarningsCalendarFromRows(rowsByDate, { nowIso, enrichedByTicker });
}

// ===== Shared status messaging (used by both MD and HTML renderers, and by
// tests, so "unavailable" and "no earnings" can never accidentally collapse
// into the same wording). =====
export function earningsCalendarStatusMessageHebrew(status: EarningsCalendarStatus): string {
  switch (status) {
    case "unavailable":
      return "לוח הרווחים אינו זמין כרגע (בעיית תקשורת עם מקור הנתונים) – לא ניתן לאשר האם קיימים דיווחי רווחים קרובים או לא. הסעיף יתעדכן בריצה הבאה.";
    case "noneFound":
      return "אין דיווחי רווחים מאושרים ברשימת המעקב, בהזדמנויות המובילות או בחברות המגה-קאפ הנבחרות ב-14 הימים הקרובים.";
    case "confirmed":
      return "";
  }
}

// Pure, testable derivation from raw per-date rows – used by
// buildEarningsCalendar above and directly by content-validation tests.
export function deriveEarningsCalendarFromRows(
  rowsByDate: Array<{ dateIso: string; rows: NasdaqEarningsRow[] | null }>,
  opts: {
    nowIso: string;
    enrichedByTicker: Map<string, { sector?: string; industry?: string }>;
  }
): EarningsCalendarResult {
  const { nowIso, enrichedByTicker } = opts;
  const tracked = new Map(trackedTickers().map((t) => [t.ticker, t.name]));

  let anySucceeded = false;
  const entries: EarningsCalendarEntry[] = [];

  for (const { dateIso, rows } of rowsByDate) {
    if (rows === null) continue;
    anySucceeded = true;
    for (const row of rows) {
      // Defensive normalization – this pure function must not assume its
      // caller already normalized the ticker casing.
      const ticker = normalizeTicker(row.symbol ?? "");
      if (!ticker || !tracked.has(ticker)) continue;
      const daysRemaining = daysBetweenIso(nowIso, dateIso);
      const enriched = enrichedByTicker.get(ticker);
      const priority: EarningsCalendarEntry["priority"] = WATCHLIST_TICKERS.has(ticker)
        ? "watchlist"
        : enrichedByTicker.has(ticker)
        ? "topOpportunity"
        : "megaCap";
      entries.push({
        ticker,
        name: tracked.get(ticker) ?? row.name ?? trackedCompanyName(ticker),
        reportDate: dateIso,
        daysRemaining,
        urgency: urgencyFor(daysRemaining),
        estimatedEps: row.epsForecast,
        timeOfDay: row.timeOfDay,
        reasonsHebrew: reasonsHebrew(row, enriched?.sector, enriched?.industry),
        priority,
      });
    }
  }

  if (!anySucceeded) return { entries: [], status: "unavailable" };

  const priorityRank: Record<EarningsCalendarEntry["priority"], number> = {
    watchlist: 0,
    topOpportunity: 1,
    megaCap: 2,
  };
  entries.sort((a, b) => {
    if (priorityRank[a.priority] !== priorityRank[b.priority]) {
      return priorityRank[a.priority] - priorityRank[b.priority];
    }
    return a.daysRemaining - b.daysRemaining;
  });

  // We DID get real calendar data for at least one date – zero matches means
  // genuinely no tracked company reports in the window, not "unavailable".
  return { entries, status: entries.length > 0 ? "confirmed" : "noneFound" };
}
