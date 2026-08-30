import "dotenv/config";
import { categorize } from "./categorizer";
import { computeDataQuality, dataQualityDebugSummary } from "./dataQuality";
import { getTopMovers } from "./dataSources";
import { buildTopOpportunities, EMERGENCY_MODE_LABEL, explainTopOpportunityRejection } from "./emergencyMode";
import {
  buildSkeletonEnriched,
  buildWatchlistStocks,
  DEFAULT_LIVE_BUDGET,
  enrichStocks,
  LiveBudget,
  REQUEST_DELAY_MS,
} from "./enricher";
import { buildEarningsCalendar } from "./earningsCalendar";
import { buildEarningsFollowUp } from "./earningsFollowUp";
import { buildDividendInfo } from "./dividends";
import { buildEconomicReadings } from "./economicIndicators";
import { getFearGreed } from "./fearGreed";
import { generateDiagnosticHtmlReport, generateHtmlReport, writeHtmlReport } from "./htmlReportGenerator";
import { selectMarketCatalyst } from "./marketCatalyst";
import { buildMarketOverview } from "./marketOverview";
import { FALLBACK_WINDOW_HOURS, selectAdditionalHeadlines, selectMarketStory } from "./marketStory";
import { buildOpportunityThesis } from "./opportunityThesis";
import { preRank } from "./ranker";
import { computeReportQuality, evaluateSendGate, formatReportQuality, formatSendGate, SEND_THRESHOLD } from "./reportQuality";
import { generateDiagnosticReport, generateReport, writeReport } from "./reportGenerator";
import { buildTechnicalAlerts, resolveTechnicalWatchPrice, technicalStatusHebrew } from "./technicalAlerts";
import { WATCHLIST, watchlistName } from "./universe";
import { buildWeekAhead } from "./weekAhead";
import {
  DimensionStatus,
  EnrichedStock,
  FearGreed,
  MarketStory,
  OpportunityThesis,
  ReportData,
  RunStatus,
  SourceInfo,
  Stock,
  TechnicalAlerts,
  TechnicalWatchItem,
} from "./types";
import { computeConfidence, computeRunDataQuality } from "./performance/tracker";
import { runTracking } from "./performance/run";
import { RecAction, RecInput, Metrics } from "./performance/types";
import { buildLatestJson, OpportunityWithRec, writeLatestJson } from "./latestJson";

// Long-term evaluation horizon for realized-return tracking.
const RECOMMENDATION_HORIZON_DAYS = Number(
  process.env.STOCK_AGENT_HORIZON_DAYS ?? 90
);

function actionForScore(score: number): RecAction {
  if (score >= 8) return "accumulate";
  if (score >= 6.5) return "watch";
  return "avoid";
}

const LIVE_BUDGET = Number(process.env.STOCK_AGENT_LIVE_BUDGET ?? DEFAULT_LIVE_BUDGET);
const ENRICH_DELAY_MS = Number(process.env.STOCK_AGENT_DELAY_MS ?? REQUEST_DELAY_MS);
// How many top-ranked movers we even attempt to enrich (budget permitting).
const MAX_MOVERS = Number(process.env.STOCK_AGENT_MAX_MOVERS ?? 8);

export interface ReportResult {
  mdPath: string;
  htmlPath: string;
  metrics: Metrics;
  status: RunStatus;
  core: EnrichedStock[];
  growth: EnrichedStock[];
  speculative: EnrichedStock[];
  watchlist: EnrichedStock[];
  technicalAlerts: TechnicalAlerts;
  fearGreed: FearGreed | null;
  marketStory: MarketStory | null;
  hasData: boolean;
  // The exact same normalized view model used to render the HTML/Markdown
  // attachments – the email renderers MUST build from this object (never a
  // hand-picked subset of it) so attachments and email can never diverge.
  data: ReportData;
  // The attachment content as actually written to disk this run, so
  // consistency validation compares against the real bytes, not a re-read.
  htmlContent: string;
  mdContent: string;
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

  // ===== Phase 1: Movers (universe of qualifying movers) – Alpha Vantage =====
  log("📡 [1/5] Loading market movers (cache-first)...");
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

  // ===== Phase 2: Watchlist quotes (priority – always shown) – Alpha Vantage =====
  log(`💧 [2/5] Fetching watchlist quotes (${WATCHLIST.length} names)...`);
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

  // ===== Phase 3: Enrich watchlist + top movers (profile + news) – Alpha Vantage =====
  log(`🔬 [3/5] Enriching watchlist & movers (live-call budget: ${budget.remaining})...`);

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

  // ===== Phase 4: Categorize, technicals (Yahoo, local calc), data quality =====
  const universe = [...wlEnriched.stocks, ...moversEnriched.stocks];
  const cats = categorize(universe);
  const qualified = universe.length;

  status.enriched =
    universe.length === 0 ? { source: "unavailable" } : { source: "live" };

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

  // Bollinger Bands + RSI, computed LOCALLY from Yahoo Finance daily closes –
  // independent of Alpha Vantage, never touches the AV daily-call budget.
  log("📊 [4/5] Computing technicals locally (Yahoo daily closes → RSI/Bollinger)...");
  const technicalUniverse = [...watchlist, ...cats.core, ...cats.growth, ...cats.speculative];
  const techResult = await buildTechnicalAlerts(technicalUniverse, {
    onProgress: (m) => log(m),
  });
  const technicalAlerts = techResult.alerts;
  log(
    `   alerts: ${technicalAlerts.aboveUpper.length} above upper band · ${technicalAlerts.belowLower.length} below lower band · ${techResult.available.size}/${technicalUniverse.length} computed`
  );

  log("🧪 Scoring data quality (coverage + confidence)...");
  const technicalStatus = (ticker: string): DimensionStatus =>
    techResult.available.has(ticker)
      ? "available"
      : techResult.rateLimited.has(ticker)
      ? "rateLimited"
      : "genuinelyMissing";
  for (const s of [...watchlist, ...universe]) {
    s.dataQuality = computeDataQuality(s, technicalStatus(s.ticker));
  }
  log("   data-quality debug (watchlist):");
  for (const s of watchlist) {
    if (!s.dataQuality) continue;
    log(
      `     ${s.ticker.padEnd(6)} coverage=${s.dataQuality.coverageScore.toString().padStart(3)} ` +
        `confidence=${s.dataQuality.confidenceScore.toString().padStart(3)} ` +
        `label=${s.dataQuality.label.padEnd(8)} excluded=${s.dataQuality.excluded} ` +
        `[${dataQualityDebugSummary(s.dataQuality)}]`
    );
  }

  // Top opportunities: ranked across tiers, only stocks that clear the quality
  // threshold (no Excluded / Low), capped at 3 – quality over quantity. When
  // nothing clears that bar, buildTopOpportunities falls back to Emergency
  // Report Mode: best-available candidates re-checked from scratch against
  // core safety rules (price, liquidity/OTC, confirmed bad news) – see
  // src/emergencyMode.ts. Never presented as normal high-confidence picks.
  const rankedCandidates = [...cats.core, ...cats.growth, ...cats.speculative]
    .filter((s) => s.price > 0)
    .sort((a, b) => b.finalScore - a.finalScore);
  const topOppResult = buildTopOpportunities(rankedCandidates, 3);
  const topOpportunities = topOppResult.topOpportunities;
  const emergencyWatch = topOppResult.emergencyWatch;
  log(`   top opportunities: ${topOpportunities.length}/3`);
  if (topOppResult.emergencyModeActive) {
    log(
      `   ⚠️  Emergency Report Mode: no candidate met the normal quality bar – ` +
        `showing ${emergencyWatch.length} best-available, safety-checked candidate(s) in a separate ` +
        `"${EMERGENCY_MODE_LABEL}" watch list, NOT as normal Top Opportunities.`
    );
  } else if (topOpportunities.length === 0) {
    log("   ⚠️  No usable candidate at all (every price is unavailable) – Top Opportunities stays empty.");
  }

  // Rejection reasons for the top 10 ranked candidates that did NOT become a
  // normal Top Opportunity – "Top Opportunities: none" must never be a
  // silent mystery when candidates were actually scanned and qualified.
  const topRankedNotSelected = rankedCandidates
    .filter((s) => !topOpportunities.includes(s))
    .slice(0, 10);
  if (topRankedNotSelected.length > 0) {
    log(`   🔎 Rejection reasons for top ${topRankedNotSelected.length} ranked candidates not in Top Opportunities:`);
    for (const s of topRankedNotSelected) {
      log(`      ${s.ticker.padEnd(6)} score=${s.finalScore.toFixed(1)} – ${explainTopOpportunityRejection(s)}`);
    }
  }

  // Technical Watch – one compact row per tracked watchlist stock. When the
  // live/cached quote is unavailable but RSI/Bollinger were still computed
  // (a completely separate Yahoo daily-closes fetch), fall back to the same
  // dataset's latest close rather than showing a valid RSI next to
  // "Price unavailable" – see src/technicalAlerts.ts's TechnicalRecord.price.
  const technicalWatch: TechnicalWatchItem[] = watchlist.map((s) => {
    const rec = techResult.byTicker.get(s.ticker);
    const resolved = resolveTechnicalWatchPrice(s.price, s.changePercent, rec);
    return {
      ticker: s.ticker,
      name: s.profile?.name ?? watchlistName(s.ticker) ?? s.ticker,
      price: resolved.price,
      changePercent: resolved.changePercent,
      isLastClose: resolved.isLastClose,
      rsi14: rec?.rsi14 ?? null,
      statusHebrew: technicalStatusHebrew(s.ticker, technicalAlerts),
    };
  });

  // ===== Performance tracking: record recs, mark/close prior ones, self-eval =====
  log("📒 Performance tracking (record → evaluate → calibrate)...");
  // Single shared timestamp for the ENTIRE run – every renderer (Markdown,
  // HTML, HTML email, text email) must show the identical "generated at"
  // moment, and every date-math call (earnings calendar window, "today")
  // must agree on what "now" is. Independent `new Date()` calls scattered
  // across renderers is exactly the kind of silent-drift bug that makes two
  // outputs of the same run look like they came from different data.
  const now = new Date();
  const generatedAt = now.toISOString();
  const { score: runDataQuality, freshness } = computeRunDataQuality(
    status.liveCount,
    status.cachedCount,
    status.missingCount
  );

  const oppsWithRec: OpportunityWithRec[] = topOpportunities.map((s) => ({
    stock: s,
    action: actionForScore(s.finalScore),
    confidence: computeConfidence(
      s.finalScore,
      s.dataQuality?.confidenceScore ?? 0,
      runDataQuality
    ),
    horizonDays: RECOMMENDATION_HORIZON_DAYS,
  }));

  const recs: RecInput[] = oppsWithRec.map(({ stock, action, confidence, horizonDays }) => ({
    symbol: stock.ticker,
    name: stock.profile?.name,
    score: stock.finalScore,
    confidence,
    entryPrice: stock.price,
    dataQuality: stock.dataQuality?.coverageScore ?? 0,
    action,
    horizonDays,
    sector: stock.profile?.industry || stock.profile?.sector,
    marketCap: stock.profile?.marketCap,
  }));

  const prices: Record<string, number> = {};
  for (const s of [...watchlist, ...universe]) {
    if (s.price > 0) prices[s.ticker] = s.price;
  }

  const { metrics } = runTracking({
    reportsDir: "reports",
    market: "US",
    nowIso: generatedAt,
    recs,
    prices,
    runDataQuality,
    freshness,
  });
  log(
    `   run data-quality: ${metrics.runDataQuality}/100 (${metrics.freshness}) · ` +
      `open: ${metrics.openCount} · closed: ${metrics.closedCount} · ` +
      `win-rate: ${metrics.winRate === null ? "n/a (building baseline)" : (metrics.winRate * 100).toFixed(0) + "%"}`
  );

  // ===== Phase 5: Newsletter sections – earnings calendar (Nasdaq), market
  // overview (Yahoo), week ahead. Both new providers are independent of
  // Alpha Vantage and never touch its daily-call budget. =====
  log("🗓️  [5/5] Building newsletter sections (Nasdaq earnings calendar, Yahoo market data)...");

  const enrichedByTicker = new Map<string, { sector?: string; industry?: string }>();
  for (const s of [...watchlist, ...topOpportunities]) {
    if (!enrichedByTicker.has(s.ticker)) {
      enrichedByTicker.set(s.ticker, {
        sector: s.profile?.sector,
        industry: s.profile?.industry,
      });
    }
  }

  const earningsCalendarRes = await buildEarningsCalendar({
    now,
    enrichedByTicker,
    onProgress: (m) => log(m),
  });
  const earningsCalendar = earningsCalendarRes.entries;
  log(
    `   earnings calendar (next 14d): ${earningsCalendarRes.status} · ${earningsCalendar.length} companies`
  );

  const marketCatalyst = selectMarketCatalyst(earningsCalendarRes);
  log(
    `   market catalyst: ${marketCatalyst.status}${marketCatalyst.catalyst ? ` – ${marketCatalyst.catalyst.headline} (${marketCatalyst.catalyst.timingHebrew})` : ""}`
  );

  const earningsFollowUp = await buildEarningsFollowUp({
    now,
    onProgress: (m) => log(m),
  });
  log(
    `   earnings follow-up (last 7d): ${earningsFollowUp.status} · ${earningsFollowUp.entries.length} companies`
  );

  const dividendInfo = buildDividendInfo([...watchlist, ...topOpportunities]);
  log(`   dividend info: ${dividendInfo.items.length} dividend-paying names (status: ${dividendInfo.status})`);

  const economicReadings = await buildEconomicReadings({
    apiKey,
    budget,
    delayMs: ENRICH_DELAY_MS,
    onProgress: (m) => {
      log(m);
      if (m.toLowerCase().includes("rate limit")) status.rateLimitHit = true;
    },
  });

  const marketOverview = await buildMarketOverview({
    fearGreed,
    onProgress: (m) => log(m),
  });
  log(
    `   market overview: ${marketOverview.filter((i) => i.value !== null).length}/${marketOverview.length} indicators with a value`
  );

  const weekAhead = buildWeekAhead(earningsCalendarRes, economicReadings);

  // Structured, non-generic thesis per Top Opportunity (Priority 5) – every
  // field is built from that stock's own real numbers.
  const opportunityTheses = new Map<string, OpportunityThesis>();
  for (const s of topOpportunities) {
    opportunityTheses.set(s.ticker, buildOpportunityThesis(s, earningsCalendar));
  }

  log("📝 Generating Hebrew reports (Markdown + HTML)...");
  const data: ReportData = {
    generatedAt,
    marketStory: null, // filled in below, once the report stocks are known
    additionalHeadlines: [],
    core: cats.core,
    growth: cats.growth,
    speculative: cats.speculative,
    topOpportunities,
    emergencyWatch,
    topOpportunitiesEmergencyMode: topOppResult.emergencyModeActive,
    opportunityTheses,
    watchlist,
    technicalWatch,
    technicalAlerts,
    status,
    scanned,
    qualified,
    fearGreed,
    earningsCalendar,
    earningsCalendarStatus: earningsCalendarRes.status,
    marketCatalyst,
    marketOverview,
    earningsFollowUp,
    dividends: dividendInfo.items,
    dividendsStatus: dividendInfo.status,
    weekAhead,
    reportQuality: { dimensions: [], score: 0, band: "Poor" }, // filled in below
    belowSendThreshold: false, // filled in below
  };

  // 📰 Market Story of the Day + up to 2 additional relevant headlines.
  // Primary window is 24h; the 48h fallback is tried ONLY when the primary
  // window found nothing, and the result is tagged isFallback so every
  // renderer must show the literal FALLBACK_NOTICE label rather than
  // presenting an up-to-2-day-old story as fresh. No window wider than 48h
  // is ever used – "genuinely nothing today" is an honest, allowed outcome.
  data.marketStory = selectMarketStory(data, Date.now());
  data.additionalHeadlines = selectAdditionalHeadlines(data, Date.now(), 2);
  if (!data.marketStory) {
    log(`   market story: nothing in the primary 24h window – trying ${FALLBACK_WINDOW_HOURS}h fallback...`);
    data.marketStory = selectMarketStory(data, Date.now(), FALLBACK_WINDOW_HOURS);
    data.additionalHeadlines = selectAdditionalHeadlines(data, Date.now(), 2, FALLBACK_WINDOW_HOURS);
  }
  log(
    data.marketStory
      ? `   market story: ${data.marketStory.ticker} – "${data.marketStory.headline}"` +
        `${data.marketStory.isFallback ? " [fallback: 24-48h old]" : ""} (+${data.additionalHeadlines.length} more headlines)`
      : `   market story: none meaningful even within ${FALLBACK_WINDOW_HOURS}h – genuinely nothing qualifies today.`
  );

  // ===== Report Quality Score – final rollup of the Data Investigation
  // phase, computed before rendering. The Market Story's own 24h->48h
  // fallback already ran above (unconditionally, not gated on this score –
  // see the block above). Below SEND_THRESHOLD, render a diagnostic-only
  // report instead of the normal newsletter (every other dimension's
  // fallback – cache / alt-provider / last-close – is already exhausted
  // DURING normal fetching, see cacheFirst everywhere, so there's nothing
  // left to retry for those specifically). =====
  const qualityUniverse = [...watchlist, ...topOpportunities];
  const quality = computeReportQuality({
    earningsCalendarStatus: earningsCalendarRes.status,
    marketOverviewWithValue: marketOverview.filter((i) => i.value !== null).length,
    marketOverviewTotal: marketOverview.length,
    watchlistPriceUsable: watchlist.filter((s) => s.price > 0).length,
    watchlistTotal: WATCHLIST.length,
    technicalsAvailable: techResult.available.size,
    technicalsTotal: technicalUniverse.length,
    newsAvailableCount: qualityUniverse.filter((s) => s.newsSource.source !== "unavailable").length,
    newsTotal: qualityUniverse.length,
    fundamentalsAvailableCount: qualityUniverse.filter((s) => s.profileSource.source !== "unavailable").length,
    fundamentalsTotal: qualityUniverse.length,
    topOpportunitiesConfidence: topOpportunities.map((s) => s.dataQuality?.confidenceScore ?? 0),
    emergencyWatchCount: emergencyWatch.length,
  });

  data.reportQuality = quality;
  data.belowSendThreshold = quality.score < SEND_THRESHOLD;
  for (const line of formatReportQuality(quality)) log(line);
  const sendGate = evaluateSendGate({
    marketOverviewUsableCount: marketOverview.filter((i) => i.value !== null).length,
    earningsCalendarStatus: earningsCalendarRes.status,
    technicalsAvailable: techResult.available.size,
    technicalsTotal: technicalUniverse.length,
    score: quality.score,
  });
  for (const line of formatSendGate(sendGate)) log(line);
  if (data.belowSendThreshold) {
    log(
      `   🔴 Report Quality Score ${quality.score}/100 is below the send threshold (${SEND_THRESHOLD}) even after recovery – ` +
        `rendering a diagnostic-only report instead of the normal newsletter.`
    );
  }

  const mdContent = data.belowSendThreshold ? generateDiagnosticReport(data) : generateReport(data);
  const htmlContent = data.belowSendThreshold ? generateDiagnosticHtmlReport(data) : generateHtmlReport(data);
  const mdPath = writeReport(mdContent);
  const htmlPath = writeHtmlReport(htmlContent);

  // Machine-readable contract for the Investment Committee (preferred over MD).
  const latestJsonPath = writeLatestJson(
    buildLatestJson({
      generatedAt,
      status,
      opportunities: oppsWithRec,
      watchlist,
      metrics,
      earningsCalendar,
      earningsCalendarStatus: earningsCalendarRes.status,
      marketCatalyst,
      marketOverview,
    })
  );
  log(`✅ Markdown report: ${mdPath}`);
  log(`✅ HTML report:     ${htmlPath}`);
  log(`✅ latest.json:     ${latestJsonPath}`);

  return {
    mdPath,
    htmlPath,
    metrics,
    status,
    core: cats.core,
    growth: cats.growth,
    speculative: cats.speculative,
    watchlist,
    technicalAlerts,
    fearGreed,
    marketStory: data.marketStory,
    hasData: universe.length > 0 || watchlist.some((s) => s.price > 0),
    data,
    htmlContent,
    mdContent,
  };
}
