import "dotenv/config";
import { categorize } from "./categorizer";
import { getTopMovers } from "./dataSources";
import {
  buildSkeletonEnriched,
  buildWatchlistStocks,
  DEFAULT_LIVE_BUDGET,
  enrichStocks,
  LiveBudget,
  REQUEST_DELAY_MS,
} from "./enricher";
import { getFearGreed } from "./fearGreed";
import { generateHtmlReport, writeHtmlReport } from "./htmlReportGenerator";
import { preRank } from "./ranker";
import { generateReport, writeReport } from "./reportGenerator";
import { buildTechnicalAlerts } from "./technicalAlerts";
import { WATCHLIST } from "./universe";
import {
  EnrichedStock,
  FearGreed,
  ReportData,
  RunStatus,
  SourceInfo,
  Stock,
  TechnicalAlerts,
} from "./types";

const LIVE_BUDGET = Number(process.env.STOCK_AGENT_LIVE_BUDGET ?? DEFAULT_LIVE_BUDGET);
const ENRICH_DELAY_MS = Number(process.env.STOCK_AGENT_DELAY_MS ?? REQUEST_DELAY_MS);
// How many top-ranked movers we even attempt to enrich (budget permitting).
const MAX_MOVERS = Number(process.env.STOCK_AGENT_MAX_MOVERS ?? 8);

export interface ReportResult {
  mdPath: string;
  htmlPath: string;
  status: RunStatus;
  core: EnrichedStock[];
  growth: EnrichedStock[];
  speculative: EnrichedStock[];
  watchlist: EnrichedStock[];
  technicalAlerts: TechnicalAlerts;
  fearGreed: FearGreed | null;
  hasData: boolean;
}

export interface RunOptions {
  log?: (msg: string) => void;
}

function describeSource(s: SourceInfo): string {
  if (s.source === "live") return "live";
  if (s.source === "cached") return `cached (${s.ageHours ?? "?"}h old)`;
  return "unavailable";
}

export async function runReport(opts: RunOptions = {}): Promise<ReportResult> {
  const log = opts.log ?? console.log.bind(console);

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey || apiKey === "your_free_api_key_here") {
    throw new Error(
      "Missing ALPHA_VANTAGE_API_KEY in .env. Get a free key at: https://www.alphavantage.co/support/#api-key"
    );
  }

  const status: RunStatus = {
    movers: { source: "unavailable" },
    enriched: { source: "unavailable" },
    rateLimitHit: false,
    notes: [],
    liveCount: 0,
    cachedCount: 0,
    missingCount: 0,
  };

  const tallyStatus = (src: SourceInfo) => {
    if (src.source === "live") status.liveCount++;
    else if (src.source === "cached") status.cachedCount++;
    else status.missingCount++;
  };

  const budget = new LiveBudget(LIVE_BUDGET);

  // ===== Phase 1: Movers (universe of qualifying movers) =====
  log("📡 [1/4] Loading market movers (cache-first)...");
  const moversRes = await getTopMovers(apiKey, (m) => {
    log(`   ${m}`);
    if (m.toLowerCase().includes("rate limit")) status.rateLimitHit = true;
    status.notes.push(m);
  });
  status.movers = moversRes.source;
  tallyStatus(moversRes.source);
  budget.note(moversRes.source);
  log(`   source: ${describeSource(moversRes.source)}`);

  const ranked = moversRes.value ? preRank(moversRes.value) : null;
  const scanned = ranked
    ? ranked.rawCounts.gainers + ranked.rawCounts.losers + ranked.rawCounts.active
    : 0;
  const watchlistTickers = new Set(WATCHLIST.map((w) => w.ticker));
  const moverCandidates: Stock[] = ranked
    ? ranked.all.filter((s) => !watchlistTickers.has(s.ticker)).slice(0, MAX_MOVERS)
    : [];
  log(`   movers scanned: ${scanned} · top candidates to consider: ${moverCandidates.length}`);

  // ===== Phase 2: Watchlist quotes (priority – always shown) =====
  log(`💧 [2/4] Fetching watchlist quotes (${WATCHLIST.length} names)...`);
  const wlQuotes = await buildWatchlistStocks({
    apiKey,
    budget,
    delayMs: ENRICH_DELAY_MS,
    onProgress: (m) => {
      log(m);
      if (m.toLowerCase().includes("rate limit")) status.rateLimitHit = true;
    },
  });
  status.liveCount += wlQuotes.tally.live;
  status.cachedCount += wlQuotes.tally.cached;
  status.missingCount += wlQuotes.tally.unavailable;

  // ===== Phase 3: Enrich watchlist + top movers (profile + news) =====
  log(`🔬 [3/4] Enriching watchlist & movers (live-call budget: ${budget.remaining})...`);

  const wlEnriched = await enrichStocks(wlQuotes.stocks, {
    apiKey,
    budget,
    delayMs: ENRICH_DELAY_MS,
    onProgress: (m) => {
      log(m);
      if (m.toLowerCase().includes("rate limit")) status.rateLimitHit = true;
    },
  });
  status.liveCount += wlEnriched.liveCalls;
  status.cachedCount += wlEnriched.cachedCalls;
  status.missingCount += wlEnriched.unavailableCalls;

  const moversEnriched = await enrichStocks(moverCandidates, {
    apiKey,
    budget,
    delayMs: ENRICH_DELAY_MS,
    onProgress: (m) => {
      log(m);
      if (m.toLowerCase().includes("rate limit")) status.rateLimitHit = true;
    },
  });
  status.liveCount += moversEnriched.liveCalls;
  status.cachedCount += moversEnriched.cachedCalls;
  status.missingCount += moversEnriched.unavailableCalls;

  // Watchlist rows in fixed order (enriched where possible, skeleton otherwise).
  const wlByTicker = new Map(wlEnriched.stocks.map((s) => [s.ticker, s]));
  const watchlist: EnrichedStock[] = wlQuotes.stocks.map(
    (s) => wlByTicker.get(s.ticker) ?? buildSkeletonEnriched(s)
  );

  // ===== Phase 4: Categorize & report =====
  // Universe for Core/Growth/Speculative = qualifying watchlist names + movers.
  const universe = [...wlEnriched.stocks, ...moversEnriched.stocks];
  const cats = categorize(universe);
  const qualified = universe.length;

  status.enriched =
    universe.length === 0 ? { source: "unavailable" } : { source: "live" };

  // Market sentiment (CNN Fear & Greed) – cache-first, independent of Alpha Vantage.
  log("🌎 Fetching CNN Fear & Greed Index (cache-first)...");
  const fearGreed = await getFearGreed((m) => {
    log(`   ${m}`);
    status.notes.push(m);
  });
  log(
    fearGreed
      ? `   Fear & Greed: ${fearGreed.score} (${fearGreed.classification})`
      : "   Fear & Greed: unavailable"
  );

  // Technical alerts (Bollinger Bands + RSI) for watchlist + every stock that
  // made it into the report. Cache-first and budget-aware like the rest.
  log("📊 Computing technical alerts (Bollinger Bands + RSI)...");
  const technicalUniverse = [
    ...watchlist,
    ...cats.core,
    ...cats.growth,
    ...cats.speculative,
  ];
  const technicalAlerts = await buildTechnicalAlerts(technicalUniverse, {
    apiKey,
    budget,
    delayMs: ENRICH_DELAY_MS,
    onProgress: (m) => {
      log(m);
      if (m.toLowerCase().includes("rate limit")) status.rateLimitHit = true;
    },
  });
  log(
    `   alerts: ${technicalAlerts.aboveUpper.length} above upper band · ${technicalAlerts.belowLower.length} below lower band`
  );

  log("📝 [4/4] Generating Hebrew reports (Markdown + HTML)...");
  const data: ReportData = {
    core: cats.core,
    growth: cats.growth,
    speculative: cats.speculative,
    watchlist,
    technicalAlerts,
    status,
    scanned,
    qualified,
    fearGreed,
  };

  const mdPath = writeReport(generateReport(data));
  const htmlPath = writeHtmlReport(generateHtmlReport(data));
  log(`✅ Markdown report: ${mdPath}`);
  log(`✅ HTML report:     ${htmlPath}`);

  return {
    mdPath,
    htmlPath,
    status,
    core: cats.core,
    growth: cats.growth,
    speculative: cats.speculative,
    watchlist,
    technicalAlerts,
    fearGreed,
    hasData: universe.length > 0 || watchlist.some((s) => s.price > 0),
  };
}
