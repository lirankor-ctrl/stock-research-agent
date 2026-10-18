// Bollinger Opportunity of the Day – orchestration.
//
//   1. Fetch ~2y daily OHLCV for the whole scan universe (Yahoo, cached).
//   2. Hard filters: US-listed common equity, USD, major exchange, not a
//      warrant/unit/OTC symbol, price ≥ $10, ≥ $20M average daily $-volume,
//      enough history, and a last bar that IS the expected session (stale
//      series are excluded, never silently used).
//   3. Indicators + setup detection on the last completed session.
//   4. Pre-rank on technicals; enrich only the top few CONFIRMED finalists
//      with fundamentals / news / earnings date (keeps API usage tiny).
//   5. Final score; select one, with the anti-repeat rule; else "none".
import { fetchCompanyOverview, sleep } from "../alphaVantage";
import { TTL } from "../cache";
import { cacheFirst, getNasdaqEarningsForDate, getNews, getOverview } from "../dataSources";
import { daysBetweenIso, usMarketDateIso } from "../dateUtils";
import { LiveBudget } from "../enricher";
import { isExcludedSecurity, MIN_MARKET_CAP, MIN_PRICE_USD } from "../filters";
import { isDirectlyAboutCompany, isPromotionalOrLegalNews } from "../newsFilter";
import { CompanyProfile, FearGreed, NewsItem } from "../types";
import { getDailyOhlcv, lastCompletedSession, mapWithConcurrency, normalizeSeries, OhlcvResult } from "./data";
import { computeSnapshots } from "./indicators";
import {
  buildTechnicalPlan,
  catalystsHebrew,
  risksHebrew,
  scenariosHebrew,
  signalExplanationHebrew,
  trendHebrew,
} from "./research";
import { assessNewsRisk, MIN_DOLLAR_VOLUME, MIN_SELECTION_SCORE, NewsRiskAssessment, scoreOpportunity } from "./scoring";
import { detectSetup, SIGNAL_LOOKBACK } from "./signals";
import {
  BollingerCandidate,
  BollingerLastPick,
  BollingerPick,
  BollingerReport,
  BollingerScanStats,
  CompanyResearch,
  PriceSeries,
  RadarItem,
} from "./types";
import { bollingerUniverse } from "./universe";

const ALLOWED_EXCHANGES = new Set(["NMS", "NGM", "NCM", "NYQ", "ASE", "PCX", "BTS"]);
const MIN_BARS = 60;
const FINALISTS = 3;
const RADAR_SIZE = 3;
const REPEAT_WINDOW_DAYS = 5;
const EARNINGS_LOOKAHEAD_DAYS = 14;

export type RejectReason = "nonEquity" | "stale" | "insufficientHistory" | "illiquid" | "noSetup";

function planScoreInputs(c: BollingerCandidate): { stopDistancePct: number; riskReward: number | null } {
  const plan = buildTechnicalPlan(c);
  return {
    stopDistancePct: ((plan.entryTrigger - plan.stopReference) / plan.entryTrigger) * 100,
    riskReward: plan.riskReward,
  };
}

export interface AnalysisResult {
  candidate: BollingerCandidate | null;
  reject?: RejectReason;
}

// Pure: one series -> candidate (pre-enrichment score) or a reject reason.
export function analyseSeries(series: PriceSeries, expectedSession: string): AnalysisResult {
  const ticker = series.symbol.replace(/-/g, ".");
  if (
    (series.instrumentType && series.instrumentType !== "EQUITY") ||
    (series.currency && series.currency !== "USD") ||
    (series.exchange && !ALLOWED_EXCHANGES.has(series.exchange)) ||
    isExcludedSecurity(ticker)
  ) {
    return { candidate: null, reject: "nonEquity" };
  }
  const bars = series.bars;
  if (bars.length < MIN_BARS) return { candidate: null, reject: "insufficientHistory" };
  if (bars[bars.length - 1].date !== expectedSession) return { candidate: null, reject: "stale" };

  const snaps = computeSnapshots(bars);
  const history = snaps.slice(-(SIGNAL_LOOKBACK + 1));
  if (history.some((s) => s === null)) return { candidate: null, reject: "insufficientHistory" };
  const hist = history as NonNullable<(typeof snaps)[number]>[];
  const snapshot = hist[hist.length - 1];

  const lastRaw = bars[bars.length - 1].rawClose;
  if (lastRaw < MIN_PRICE_USD || snapshot.avgDollarVolume20 === null || snapshot.avgDollarVolume20 < MIN_DOLLAR_VOLUME) {
    return { candidate: null, reject: "illiquid" };
  }

  const signal = detectSetup(hist);
  if (!signal) return { candidate: null, reject: "noSetup" };

  const candidate: BollingerCandidate = {
    symbol: series.symbol,
    name: series.name ?? series.symbol,
    series,
    snapshot,
    history: hist,
    signal,
    score: { total: 0, components: [], penalties: [] },
    enriched: false,
  };
  candidate.score = scoreOpportunity({
    snapshot,
    signal,
    isFresh: true,
    barCount: bars.length,
    hasFundamentals: false,
    newsRisk: null,
    ...planScoreInputs(candidate),
  });
  return { candidate };
}

// ===== Selection (pure) =====

// A pick must be a CONFIRMED signal, clear the score bar, AND offer at least
// as much technical upside as downside to its invalidation level – a setup
// with R/R < 1 is not a high-confidence long idea however clean it looks.
export const MIN_RISK_REWARD = 1;

export function qualifiesForSelection(c: BollingerCandidate, minScore = MIN_SELECTION_SCORE): boolean {
  const rr = buildTechnicalPlan(c).riskReward;
  return c.signal.status === "confirmed" && c.score.total >= minScore && rr !== null && rr >= MIN_RISK_REWARD;
}

export function isMateriallyNew(c: BollingerCandidate, last: BollingerLastPick): boolean {
  return c.signal.type !== last.setupType || (last.status !== "confirmed" && c.signal.status === "confirmed");
}

export interface Selection {
  selected: BollingerCandidate | null;
  repeatNoteHebrew?: string;
  noneReasonHebrew?: string;
}

// `ranked` must already be sorted by final score, descending.
export function selectOpportunity(
  ranked: BollingerCandidate[],
  last: BollingerLastPick | null,
  reportTradingDate: string,
  minScore = MIN_SELECTION_SCORE
): Selection {
  const qualifying = ranked.filter((c) => qualifiesForSelection(c, minScore));
  if (qualifying.length === 0) {
    const best = ranked[0];
    return {
      selected: null,
      noneReasonHebrew: best
        ? `המועמד הטוב ביותר (${best.symbol}, ${best.score.total}/100, ${best.signal.status === "confirmed" ? "מאושר" : "מתהווה"}) לא עבר את סף האיכות (ציון ${minScore}/100, אות מאושר ויחס סיכוי/סיכון ≥ ${MIN_RISK_REWARD}).`
        : "לא נמצא אף סטאפ בולינגר בסריקה של היום.",
    };
  }
  const top = qualifying[0];
  const recent =
    last !== null &&
    last.tradingDate !== reportTradingDate &&
    daysBetweenIso(last.tradingDate, reportTradingDate) <= REPEAT_WINDOW_DAYS &&
    daysBetweenIso(last.tradingDate, reportTradingDate) > 0;
  if (!recent || top.symbol !== last!.ticker || isMateriallyNew(top, last!)) {
    return {
      selected: top,
      repeatNoteHebrew:
        recent && top.symbol === last!.ticker ? `נבחרה גם בדוח הקודם – נבחרה שוב בגלל אות חדש מהותית (${top.signal.type}).` : undefined,
    };
  }
  const alternative = qualifying.find((c) => c.symbol !== last!.ticker);
  if (alternative) {
    return {
      selected: alternative,
      repeatNoteHebrew: `${top.symbol} דורגה גבוה יותר אך נבחרה כבר בדוח הקודם ללא אות חדש מהותית – הוצגה ההזדמנות המובילה הבאה שעוברת את הסף.`,
    };
  }
  return {
    selected: null,
    noneReasonHebrew: `ההזדמנות היחידה שעוברת את הסף היא ${top.symbol} – אותה מניה ואותו אות כמו בדוח הקודם, ללא אות חדש מהותית. הסטאפ עדיין בתוקף; אין הזדמנות חדשה ברמת ביטחון גבוהה.`,
  };
}

// ===== Enrichment (I/O) =====

export interface BollingerScanOptions {
  now: Date;
  apiKey: string;
  budget: LiveBudget;
  delayMs: number;
  fearGreed: FearGreed | null;
  lastPick: BollingerLastPick | null;
  extraTickers?: string[];
  onProgress?: (msg: string) => void;
  fetchOhlcv?: (symbol: string, now: Date) => Promise<OhlcvResult>;
}

async function findNextEarnings(ticker: string, now: Date): Promise<{ date: string; timing?: "pre-market" | "post-market" } | null> {
  for (let offset = 0; offset <= EARNINGS_LOOKAHEAD_DAYS; offset++) {
    const dateIso = usMarketDateIso(new Date(now.getTime() + offset * 24 * 60 * 60 * 1000));
    const res = await getNasdaqEarningsForDate(dateIso);
    const row = res.value?.find((r) => r.symbol.toUpperCase() === ticker);
    if (row) return { date: dateIso, timing: row.timeOfDay };
  }
  return null;
}

function relevantNews(ticker: string, name: string, news: NewsItem[]): NewsItem[] {
  return news
    .filter((n) => !isPromotionalOrLegalNews(n) && isDirectlyAboutCompany(ticker, name, n))
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
    .slice(0, 3);
}

interface Enrichment {
  research: CompanyResearch;
  newsRisk: NewsRiskAssessment;
  daysToEarnings: number | null;
  belowCapFloor: boolean;
}

async function enrichCandidate(c: BollingerCandidate, opts: BollingerScanOptions): Promise<Enrichment> {
  const { apiKey, budget, delayMs, now, onProgress = () => {} } = opts;
  const ticker = c.symbol.replace(/-/g, ".");
  const note = (m: string) => onProgress(`     ${m}`);

  const overview = await getOverview(ticker, apiKey, note, budget.allow);
  if (overview.usedAlpha && overview.source.source === "live") {
    budget.note(overview.source);
    await sleep(delayMs);
  }
  const newsRes = await getNews(ticker, apiKey, note, budget.allow);
  if (newsRes.usedAlpha && newsRes.source.source === "live") {
    budget.note(newsRes.source);
    await sleep(delayMs);
  }
  const profile = overview.value ?? undefined;
  if (profile?.name) c.name = profile.name;
  const news = newsRes.value ? relevantNews(ticker, c.name, newsRes.value) : null;
  const earnings = await findNextEarnings(ticker, now);
  const daysToEarnings = earnings ? daysBetweenIso(usMarketDateIso(now), earnings.date) : null;

  const research: CompanyResearch = {
    sector: profile?.sector,
    industry: profile?.industry,
    description: profile?.description,
    marketCap: profile?.marketCap,
    peRatio: profile?.peRatio,
    eps: profile?.eps,
    profitMargin: profile?.profitMargin,
    dividendYield: profile?.dividendYield,
    profileSource: overview.source,
    news: news ?? [],
    newsSource: newsRes.source,
    nextEarningsDate: earnings?.date,
    nextEarningsTiming: earnings?.timing,
  };
  return {
    research,
    newsRisk: assessNewsRisk({ news, daysToEarnings }),
    daysToEarnings,
    belowCapFloor: profile?.marketCap !== undefined && profile.marketCap < MIN_MARKET_CAP,
  };
}

// Finnhub's profile (production's primary fundamentals source) carries no
// business description; Alpha Vantage OVERVIEW does. Looked up for the ONE
// selected company only, budget-gated and cached 7 days – at most one Alpha
// Vantage call a day, and none when the budget is already spent.
async function fetchDescription(symbol: string, opts: BollingerScanOptions): Promise<string | undefined> {
  const ticker = symbol.replace(/-/g, ".");
  const res = await cacheFirst<CompanyProfile>(
    `overview_av_${ticker}`,
    TTL.DAYS_7,
    () => fetchCompanyOverview(ticker, opts.apiKey),
    (m) => opts.onProgress?.(`     ${m}`),
    opts.budget.allow
  );
  if (res.source.source === "live") {
    opts.budget.note(res.source);
    await sleep(opts.delayMs);
  }
  return res.value?.description || undefined;
}

function toRadar(c: BollingerCandidate): RadarItem {
  return {
    symbol: c.symbol,
    name: c.name,
    type: c.signal.type,
    status: c.signal.status,
    score: c.score.total,
    close: c.snapshot.close,
    percentB: c.snapshot.percentB,
    rsi14: c.snapshot.rsi14,
  };
}

export async function runBollingerScan(opts: BollingerScanOptions): Promise<BollingerReport> {
  const { now, onProgress = () => {}, fetchOhlcv = getDailyOhlcv } = opts;
  const expectedSession = lastCompletedSession(now);
  const universe = bollingerUniverse(opts.extraTickers ?? []);
  onProgress(`   scanning ${universe.length} symbols · expected last completed session ${expectedSession}`);

  const results = await mapWithConcurrency(universe, 4, (sym) => fetchOhlcv(sym, now));
  const stats: BollingerScanStats = {
    universe: universe.length,
    fetched: 0,
    stale: 0,
    insufficientHistory: 0,
    excluded: 0,
    analysed: 0,
    setupsFound: 0,
    confirmed: 0,
    expectedSession,
    adjustment: "split+dividend (Yahoo adjclose)",
  };

  const candidates: BollingerCandidate[] = [];
  let splitOnly = 0;
  for (const r of results) {
    if (!r.raw) continue;
    stats.fetched++;
    const series = normalizeSeries(r.raw, now);
    if (series.adjustment === "split-only") splitOnly++;
    const res = analyseSeries(series, expectedSession);
    if (res.reject === "stale") stats.stale++;
    else if (res.reject === "insufficientHistory") stats.insufficientHistory++;
    else if (res.reject === "nonEquity" || res.reject === "illiquid") stats.excluded++;
    else stats.analysed++;
    if (res.candidate) candidates.push(res.candidate);
  }
  if (splitOnly > 0) stats.adjustment += ` · ${splitOnly} split-only (no adjclose)`;
  stats.setupsFound = candidates.length;
  stats.confirmed = candidates.filter((c) => c.signal.status === "confirmed").length;
  onProgress(
    `   fetched ${stats.fetched}/${stats.universe} · stale ${stats.stale} · short history ${stats.insufficientHistory} · ` +
      `excluded ${stats.excluded} · setups ${stats.setupsFound} (${stats.confirmed} confirmed)`
  );

  if (stats.fetched === 0) {
    return { status: "unavailable", pick: null, radar: [], stats, minScore: MIN_SELECTION_SCORE, noneReasonHebrew: "נתוני מחיר יומיים לא היו זמינים לסריקה." };
  }

  candidates.sort((a, b) => b.score.total - a.score.total);
  // News can move a pre-rank score by at most +5 (neutral 5 → 10), so a
  // finalist must already be within 5 points of the bar.
  const finalists = candidates
    .filter((c) => c.signal.status === "confirmed" && c.score.total >= MIN_SELECTION_SCORE - 5)
    .slice(0, FINALISTS + (opts.lastPick ? 1 : 0));

  const enrichments = new Map<string, Enrichment>();
  for (const c of finalists) {
    onProgress(`   enriching finalist ${c.symbol} (pre-rank ${c.score.total})...`);
    const e = await enrichCandidate(c, opts);
    enrichments.set(c.symbol, e);
    c.score = scoreOpportunity({
      snapshot: c.snapshot,
      signal: c.signal,
      isFresh: true,
      barCount: c.series.bars.length,
      hasFundamentals: e.research.profileSource.source !== "unavailable" && e.research.marketCap !== undefined,
      newsRisk: e.newsRisk,
      ...planScoreInputs(c),
    });
    c.enriched = true;
    if (e.belowCapFloor) {
      c.score.penalties.push({ key: "smallCap", points: 100, note: "market cap below $2B – outside the large/mid-cap mandate" });
      c.score.total = 0;
    }
  }
  candidates.sort((a, b) => b.score.total - a.score.total);

  const reportTradingDate = usMarketDateIso(now);
  // Only enriched candidates may be selected – a pick must have had its
  // news/event risk actually checked.
  const selection = selectOpportunity(candidates.filter((c) => c.enriched), opts.lastPick, reportTradingDate);
  const radar = candidates.filter((c) => c !== selection.selected && c.score.total > 0).slice(0, RADAR_SIZE).map(toRadar);

  if (!selection.selected) {
    return {
      status: "none",
      pick: null,
      radar,
      stats,
      minScore: MIN_SELECTION_SCORE,
      noneReasonHebrew: selection.noneReasonHebrew ?? (candidates[0] ? undefined : "לא נמצא אף סטאפ בולינגר בסריקה של היום."),
    };
  }

  const c = selection.selected;
  const e = enrichments.get(c.symbol)!;
  if (!e.research.description) e.research.description = await fetchDescription(c.symbol, opts);
  const plan = buildTechnicalPlan(c);
  const scenarios = scenariosHebrew(c, plan);
  const pick: BollingerPick = {
    candidate: c,
    research: e.research,
    plan,
    signalExplanationHebrew: signalExplanationHebrew(c),
    trendHebrew: trendHebrew(c.snapshot),
    bullishHebrew: scenarios.bullish,
    bearishHebrew: scenarios.bearish,
    risksHebrew: risksHebrew(c.score.penalties, e.research, e.newsRisk, e.daysToEarnings, opts.fearGreed),
    catalystsHebrew: catalystsHebrew(e.research, e.daysToEarnings),
    repeatNoteHebrew: selection.repeatNoteHebrew,
  };
  return { status: "selected", pick, radar, stats, minScore: MIN_SELECTION_SCORE };
}
