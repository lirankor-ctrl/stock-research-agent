import { daysBetweenIso, normalizeTicker, usMarketDateIso } from "./dateUtils";
import { getNasdaqEarningsForDate } from "./dataSources";
import { NasdaqEarningsRow } from "./nasdaqEarnings";
import { EarningsCalendarEntry, EarningsCalendarStatus, EarningsUrgency } from "./types";
import { isIndexMember, trackedCompanyName, WATCHLIST_TICKERS } from "./universe";

// Primary discovery window: every company reporting in the next 7 calendar
// days is a ranking candidate. The 8-14 day window is secondary – only
// pulled from when the primary window alone can't reach TARGET_MIN.
const PRIMARY_WINDOW_DAYS = 7;
const SECONDARY_WINDOW_DAYS = 14;

// Normal day target: enough to be genuinely useful, never a full market dump.
const TARGET_MIN = 5;
const TARGET_MAX = 10;

// A company needs at least this market cap (or watchlist/index membership,
// which bypasses the floor entirely) to enter the ranking pool at all – this
// is what keeps "not every micro-cap" true without silently hiding anything
// meaningful. Below this floor there are, on a typical day, dozens of
// thinly-traded names reporting that nobody researching long-term ideas
// would call "interesting".
const MIN_MARKET_CAP_FOR_RANKING = 1_000_000_000;

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
  for (let offset = 0; offset <= SECONDARY_WINDOW_DAYS; offset++) {
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
      return "לא אותרו חברות מוכרות עם דיווחי רווחים מתוכננים ב-14 הימים הקרובים, מתוך לוח הרווחים המלא של השוק האמריקאי.";
    case "confirmed":
      return "";
  }
}

// Importance score used to rank the FULL market's reporting companies (not
// just our watchlist) – higher wins. Deliberately built only from fields
// Nasdaq's calendar itself provides (market cap, EPS estimates) plus our own
// curated index-membership sets, so ranking never costs an extra API call of
// any kind, Alpha Vantage or otherwise.
function importanceScore(ticker: string, row: NasdaqEarningsRow, isWatchlist: boolean): number {
  if (isWatchlist) return Number.MAX_SAFE_INTEGER; // always first, full stop.
  let score = 0;
  if (isIndexMember(ticker)) score += 5_000;
  const cap = row.marketCap ?? 0;
  if (cap >= 500_000_000_000) score += 4_000;
  else if (cap >= 100_000_000_000) score += 3_000;
  else if (cap >= 20_000_000_000) score += 2_000;
  else if (cap >= 5_000_000_000) score += 1_000;
  else if (cap >= MIN_MARKET_CAP_FOR_RANKING) score += 300;
  // A real YoY EPS comparison is available -> a more substantive, concrete
  // report worth flagging over one we can only describe generically.
  if (row.epsForecast !== undefined && row.lastYearEPS !== undefined) score += 50;
  return score;
}

// A company must clear index membership or a market-cap floor to even enter
// the ranking pool – otherwise a normal trading day's several dozen
// micro-cap reporters would drown out anything genuinely interesting.
// Watchlist names always qualify, floor or not.
function qualifiesForRanking(ticker: string, row: NasdaqEarningsRow, isWatchlist: boolean): boolean {
  if (isWatchlist) return true;
  if (isIndexMember(ticker)) return true;
  return (row.marketCap ?? 0) >= MIN_MARKET_CAP_FOR_RANKING;
}

interface ScoredEntry {
  entry: EarningsCalendarEntry;
  score: number;
}

// Pure, testable derivation from raw per-date rows – used by
// buildEarningsCalendar above and directly by content-validation tests.
// Searches the FULL market calendar (every row Nasdaq returned for every
// date, not a pre-filtered tracked-ticker list) and ranks by importance –
// see importanceScore/qualifiesForRanking above. Watchlist names are always
// included regardless of rank; everything else competes on merit so a quiet
// week for our own names still surfaces genuinely notable earnings.
export function deriveEarningsCalendarFromRows(
  rowsByDate: Array<{ dateIso: string; rows: NasdaqEarningsRow[] | null }>,
  opts: {
    nowIso: string;
    enrichedByTicker: Map<string, { sector?: string; industry?: string }>;
  }
): EarningsCalendarResult {
  const { nowIso, enrichedByTicker } = opts;

  let anySucceeded = false;
  const primary: ScoredEntry[] = [];
  const secondary: ScoredEntry[] = [];

  for (const { dateIso, rows } of rowsByDate) {
    if (rows === null) continue;
    anySucceeded = true;
    const daysRemaining = daysBetweenIso(nowIso, dateIso);

    for (const row of rows) {
      // Defensive normalization – this pure function must not assume its
      // caller already normalized the ticker casing.
      const ticker = normalizeTicker(row.symbol ?? "");
      if (!ticker) continue;
      const isWatchlist = WATCHLIST_TICKERS.has(ticker);
      if (!qualifiesForRanking(ticker, row, isWatchlist)) continue;

      const enriched = enrichedByTicker.get(ticker);
      const priority: EarningsCalendarEntry["priority"] = isWatchlist
        ? "watchlist"
        : enrichedByTicker.has(ticker)
        ? "topOpportunity"
        : "megaCap";
      const entry: EarningsCalendarEntry = {
        ticker,
        name: row.name || trackedCompanyName(ticker),
        reportDate: dateIso,
        daysRemaining,
        urgency: urgencyFor(daysRemaining),
        estimatedEps: row.epsForecast,
        estimatedRevenue: row.revenueForecast,
        timeOfDay: row.timeOfDay,
        reasonsHebrew: reasonsHebrew(row, enriched?.sector, enriched?.industry),
        priority,
      };
      const scored: ScoredEntry = { entry, score: importanceScore(ticker, row, isWatchlist) };
      if (daysRemaining <= PRIMARY_WINDOW_DAYS) primary.push(scored);
      else if (daysRemaining <= SECONDARY_WINDOW_DAYS) secondary.push(scored);
    }
  }

  if (!anySucceeded) return { entries: [], status: "unavailable" };

  const byScoreThenSoonest = (a: ScoredEntry, b: ScoredEntry) =>
    b.score - a.score || a.entry.daysRemaining - b.entry.daysRemaining;
  primary.sort(byScoreThenSoonest);
  secondary.sort(byScoreThenSoonest);

  // Watchlist names are guaranteed inclusion, however many there are, before
  // anything else competes for the remaining slots.
  const watchlistEntries = primary.filter((c) => c.entry.priority === "watchlist").map((c) => c.entry);
  const rest = primary.filter((c) => c.entry.priority !== "watchlist");

  const selected: EarningsCalendarEntry[] = [...watchlistEntries];
  for (const c of rest) {
    if (selected.length >= TARGET_MAX) break;
    selected.push(c.entry);
  }
  // The primary (0-7 day) window alone didn't reach a normally-useful count
  // – reach into the secondary (8-14 day) window rather than pad with
  // anything that didn't clear the ranking bar.
  if (selected.length < TARGET_MIN) {
    for (const c of secondary) {
      if (selected.length >= TARGET_MIN) break;
      selected.push(c.entry);
    }
  }

  const priorityRank: Record<EarningsCalendarEntry["priority"], number> = {
    watchlist: 0,
    topOpportunity: 1,
    megaCap: 2,
  };
  selected.sort((a, b) => {
    if (priorityRank[a.priority] !== priorityRank[b.priority]) {
      return priorityRank[a.priority] - priorityRank[b.priority];
    }
    return a.daysRemaining - b.daysRemaining;
  });

  // We DID get real calendar data for at least one date – zero matches means
  // genuinely no qualifying company reports in the window, not "unavailable".
  return { entries: selected, status: selected.length > 0 ? "confirmed" : "noneFound" };
}
