// Deterministic content-validation checks for the newsletter's reliability
// and quality rules (no live API calls – synthetic inputs only).
//
//   npm run content:selftest

import fs from "fs";
import path from "path";
import { RateLimitError } from "./alphaVantage";
import { computeDataQuality } from "./dataQuality";
import { cacheFirst } from "./dataSources";
import { deriveEarningsCalendarFromRows } from "./earningsCalendar";
import { earningsFollowUpStatusMessageHebrew } from "./earningsFollowUp";
import { buildInterpretation, classifyBeatMiss, computeEarningsReaction, computeSurprisePct, excludeUnsettledSession } from "./earningsReaction";
import {
  ClosesFetcher,
  filterOutReported,
  loadTracker,
  pruneOldRecords,
  ResultsFetcher,
  resolveReportedTiming,
  runEarningsTracker,
  saveTracker,
  selectDisplayRecords,
  upsertTrackedEarnings,
} from "./earningsTracker";
import { generateEmailHtmlBody, generateEmailTextBody } from "./emailBodyGenerator";
import { isUsEarlyCloseDay, isUsMarketHoliday, isUsTradingDay, usMarketCloseMinute, usMarketHolidayName, usMarketHolidays } from "./marketCalendar";
import { diagnoseSchedule } from "./scheduleDiagnostics";
import { buildTopOpportunities, EMERGENCY_MODE_LABEL, passesEmergencySafetyFilter, summarizeRejections } from "./emergencyMode";
import { passesLongTermFilter } from "./filters";
import { generateDiagnosticHtmlReport, generateHtmlReport } from "./htmlReportGenerator";
import { DatedClose } from "./marketData";
import { selectMarketStory } from "./marketStory";
import { MIN_VISIBLE_INDICATORS, visibleOverviewItems } from "./marketOverview";
import { NasdaqEarningsRow } from "./nasdaqEarnings";
import { isEtfOrLeveragedFundNews, isPromotionalOrLegalNews, materiality, sourceQualityScore } from "./newsFilter";
import { buildOpportunityThesis } from "./opportunityThesis";
import { validatePresentation } from "./presentationValidation";
import { providerForCacheKey, summarizeProviderFailures } from "./providerLedger";
import { throttleFinnhub } from "./finnhubThrottle";
import { computeProvenance, extractProvenance } from "./reportFingerprint";
import { generateDiagnosticReport, generateReport } from "./reportGenerator";
import { buildReportHealth, formatReportHealth } from "./reportHealth";
import { EMAIL_MAX_WIDTH, formatOverviewValue, weekAheadExtraEarnings } from "./reportPresentation";
import { computeReportQuality, RECOVERY_THRESHOLD, ReportQuality, SEND_THRESHOLD } from "./reportQuality";
import { classifyReportTiming, DELAYED_THRESHOLD_MINUTES, MAX_LATENESS_MINUTES, usMarketState } from "./reportTiming";
import { alreadySentForTradingDate, loadReportState, parseReportState, saveReportState } from "./reportState";
import { loadRunSnapshots, saveLedger, upsertRunSnapshot } from "./performance/store";
import { recordRecommendations } from "./performance/tracker";
import { validateReportConsistency } from "./reportValidation";
import { resolveTechnicalWatchPrice, trendLabelHebrew } from "./technicalAlerts";
import { computeTechnicals, movingAverageTrend } from "./technicals";
import {
  DataQuality,
  EarningsCalendarEntry,
  EarningsTrackingRecord,
  EconomicReading,
  EnrichedStock,
  MarketOverviewItem,
  NewsItem,
  ReportData,
} from "./types";

// Shared "everything's fine" quality fixture for tests that aren't
// exercising the Report Quality Score / recovery-pass logic itself.
const GOOD_QUALITY: ReportQuality = { dimensions: [], score: 100, band: "Excellent" };

// Shared "nothing tracked yet" earnings-follow-up coverage fixture, for
// fixtures that aren't exercising the earnings tracker itself.
const ZERO_EARNINGS_COVERAGE = { tracked: 0, awaiting: 0, resultsFound: 0, resultsUnavailable: 0, reactionsCalculated: 0 };

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${msg}`);
  }
}

// ---------- shared synthetic fixtures ----------

function makeStock(overrides: Partial<EnrichedStock> = {}): EnrichedStock {
  return {
    ticker: "TEST",
    price: 100,
    changePercent: 1,
    volume: 1_000_000,
    category: "active",
    origin: "watchlist",
    preScore: 0,
    quoteSource: { source: "live" },
    profile: {
      symbol: "TEST",
      name: "Test Corp",
      sector: "TECHNOLOGY",
      industry: "SOFTWARE",
      marketCap: 500_000_000_000,
      eps: 5,
      profitMargin: 0.3,
    },
    news: [],
    whyHebrew: "",
    longTermWhyHebrew: "",
    tier: "core",
    score: { companyQuality: 8, momentum: 5, volume: 5, newsQuality: 5, penalty: 1, total: 8 },
    finalScore: 8,
    profileSource: { source: "live" },
    newsSource: { source: "live" },
    ...overrides,
  };
}

function makeNews(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    title: "Company announces record quarterly earnings",
    url: "https://example.com/a",
    source: "Example Wire",
    publishedAt: "20260721T120000",
    sentimentScore: 0.3,
    sentimentLabel: "Bullish",
    relevanceScore: 0.8,
    ...overrides,
  };
}

function nasdaqRow(overrides: Partial<NasdaqEarningsRow> = {}): NasdaqEarningsRow {
  return { symbol: "META", name: "Meta Platforms, Inc.", ...overrides };
}

function makeDQ(overrides: Partial<DataQuality> = {}): DataQuality {
  return {
    statuses: {
      price: "available",
      volume: "available",
      marketCap: "available",
      profile: "available",
      news: "available",
      technical: "available",
    },
    coverageScore: 100,
    confidenceScore: 100,
    label: "High",
    excluded: false,
    missing: [],
    rateLimited: [],
    reliabilityHebrew: "",
    ...overrides,
  };
}

function makeReportData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    generatedAt: "2026-08-07T13:00:00.000Z",
    marketStory: null,
    additionalHeadlines: [],
    core: [],
    growth: [],
    speculative: [],
    topOpportunities: [],
    emergencyWatch: [],
    topOpportunitiesEmergencyMode: false,
    reportQuality: GOOD_QUALITY,
    belowSendThreshold: false,
    opportunityTheses: new Map(),
    watchlist: [],
    technicalWatch: [],
    technicalAlerts: {
      aboveUpper: [],
      belowLower: [],
      closestToUpper: [],
      closestToLower: [],
      expansion: [],
      dataUnavailable: false,
    },
    status: {
      movers: { source: "live" },
      enriched: { source: "live" },
      rateLimitHit: false,
      notes: [],
      liveCount: 0,
      cachedCount: 0,
      missingCount: 0,
    },
    scanned: 0,
    qualified: 0,
    fearGreed: null,
    earningsCalendar: [],
    earningsCalendarStatus: "noneFound",
    marketCatalyst: { catalyst: null, status: "noneFound" },
    marketOverview: [],
    earningsFollowUp: { entries: [], status: "noneFound", coverage: ZERO_EARNINGS_COVERAGE },
    dividends: [],
    dividendsStatus: "confirmed",
    weekAhead: {
      earnings: [],
      earningsStatus: "noneFound",
      economicReadings: [],
      economicUnavailableCount: 0,
      unavailableNoticeHebrew: "",
    },
    ...overrides,
  };
}

// ===== Priority 1: Earnings calendar contains real upcoming events =====
{
  const rowsByDate = [
    { dateIso: "2026-07-21", rows: [] as NasdaqEarningsRow[] },
    {
      dateIso: "2026-07-29",
      rows: [nasdaqRow({ symbol: "meta", timeOfDay: "post-market", epsForecast: 7.13, lastYearEPS: 7.14 })],
    },
    { dateIso: "2026-07-30", rows: [nasdaqRow({ symbol: "AMZN", name: "Amazon.com" })] },
    { dateIso: "2026-07-25", rows: [nasdaqRow({ symbol: "ZZZZ", name: "Untracked Co" })] },
  ];
  const result = deriveEarningsCalendarFromRows(rowsByDate, {
    nowIso: "2026-07-21",
    enrichedByTicker: new Map(),
  });

  assert(result.status === "confirmed", "known upcoming earnings (real rows) -> status 'confirmed'");
  const meta = result.entries.find((e) => e.ticker === "META");
  assert(!!meta, "META earnings entry is present (lowercase ticker normalized to uppercase)");
  assert(meta?.daysRemaining === 8, "META daysRemaining computed correctly (2026-07-21 -> 2026-07-29 = 8)");
  assert(meta?.timeOfDay === "post-market", "META Before/After Market is captured as 'post-market' (After Market)");
  assert((meta?.reasonsHebrew.length ?? 0) >= 1 && (meta?.reasonsHebrew.length ?? 0) <= 3, "META has 1-3 real reasons");
  const amzn = result.entries.find((e) => e.ticker === "AMZN");
  assert(!!amzn && amzn.daysRemaining === 9, "AMZN earnings entry present with correct daysRemaining");
  assert(!result.entries.some((e) => e.ticker === "ZZZZ"), "untracked ticker is excluded from the calendar");
}

// ===== Priority 1: Unavailable earnings data is not described as "no earnings" =====
{
  const allFailed = deriveEarningsCalendarFromRows(
    [
      { dateIso: "2026-07-21", rows: null },
      { dateIso: "2026-07-22", rows: null },
    ],
    { nowIso: "2026-07-21", enrichedByTicker: new Map() }
  );
  assert(allFailed.status === "unavailable", "every date's fetch failing -> status 'unavailable', not 'noneFound'");

  const genuinelyEmpty = deriveEarningsCalendarFromRows(
    [{ dateIso: "2026-07-21", rows: [] }],
    { nowIso: "2026-07-21", enrichedByTicker: new Map() }
  );
  assert(genuinelyEmpty.status === "noneFound", "a real (successful) empty calendar -> status 'noneFound'");
  assert(allFailed.status !== genuinelyEmpty.status, "'unavailable' and 'noneFound' are never the same status");
}

// ===== Priority 3: Technical indicators are calculated locally (pure fn,
// no network) from a raw daily-close price series =====
{
  const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2);
  const tech = computeTechnicals(closes);
  assert(!!tech, "computeTechnicals produces a result from a plain local price array (no API call)");
  assert(tech !== null && tech.rsi14 >= 0 && tech.rsi14 <= 100, "locally computed RSI(14) is in the valid 0-100 range");
  assert(tech !== null && tech.bands.upper > tech.bands.lower, "locally computed Bollinger upper band > lower band");
}

// ===== Priority 4: Low-value institutional-holding / insider-sale articles
// never drive a Top Opportunity (excluded from news relevance) =====
{
  const institutional = makeNews({
    title: "Vanguard Group Inc. Has $4.38 Million Position in Amazon.com, Inc. $AMZN",
  });
  assert(isPromotionalOrLegalNews(institutional), "small institutional-position disclosure is excluded");

  const insiderSale = makeNews({ title: "Insider sells 20,000 shares of CrowdStrike Holdings" });
  assert(isPromotionalOrLegalNews(insiderSale), "routine insider sale headline is excluded");

  const passiveVoiceInstitutional = makeNews({
    title: "Amazon.com, Inc. $AMZN Position Boosted by Griffith & Werner Inc.",
  });
  assert(
    isPromotionalOrLegalNews(passiveVoiceInstitutional),
    "passive-voice institutional filing headline ('Position Boosted by ...') is excluded"
  );

  const bareAnalyst = makeNews({ title: "Wells Fargo Maintains Palo Alto Networks Rating" });
  assert(isPromotionalOrLegalNews(bareAnalyst), "bare analyst mention with no price target/reasoning is excluded");

  const analystWithReasoning = makeNews({
    title: "Wells Fargo Maintains Palo Alto Networks With Buy Rating, Cuts Target Price to $420",
  });
  assert(!isPromotionalOrLegalNews(analystWithReasoning), "analyst call WITH a price target is substantive, not excluded");

  const stockWithOnlyInstitutionalNews = makeStock({ ticker: "INSTONLY", news: [institutional] });
  const reportData: ReportData = {
    generatedAt: "2026-07-21T13:00:00.000Z",
    marketStory: null,
    additionalHeadlines: [],
    core: [stockWithOnlyInstitutionalNews],
    growth: [],
    speculative: [],
    topOpportunities: [],
    emergencyWatch: [],
    topOpportunitiesEmergencyMode: false,
    reportQuality: GOOD_QUALITY,
    belowSendThreshold: false,
    opportunityTheses: new Map(),
    watchlist: [stockWithOnlyInstitutionalNews],
    technicalWatch: [],
    technicalAlerts: {
      aboveUpper: [],
      belowLower: [],
      closestToUpper: [],
      closestToLower: [],
      expansion: [],
      dataUnavailable: false,
    },
    status: {
      movers: { source: "live" },
      enriched: { source: "live" },
      rateLimitHit: false,
      notes: [],
      liveCount: 0,
      cachedCount: 0,
      missingCount: 0,
    },
    scanned: 0,
    qualified: 0,
    fearGreed: null,
    earningsCalendar: [],
    earningsCalendarStatus: "noneFound",
    marketCatalyst: { catalyst: null, status: "noneFound" },
    marketOverview: [],
    earningsFollowUp: { entries: [], status: "noneFound", coverage: ZERO_EARNINGS_COVERAGE },
    dividends: [],
    dividendsStatus: "confirmed",
    weekAhead: {
      earnings: [],
      earningsStatus: "noneFound",
      economicReadings: [],
      economicUnavailableCount: 0,
      unavailableNoticeHebrew: "",
    },
  };
  const story = selectMarketStory(reportData, Date.parse("2026-07-21T13:00:00Z"));
  assert(story === null, "when the ONLY news is a small institutional-position disclosure, no Market Story is selected");
}

// ===== Priority 5: No two opportunity explanations are substantially
// identical – built from each stock's own real numbers =====
{
  const stockA = makeStock({
    ticker: "AAA",
    changePercent: 2,
    profile: { symbol: "AAA", name: "Alpha Corp", marketCap: 800_000_000_000, peRatio: 25, profitMargin: 0.22, eps: 4 },
    news: [makeNews({ title: "Alpha Corp announces new product launch", url: "https://example.com/a" })],
  });
  const stockB = makeStock({
    ticker: "BBB",
    changePercent: -3,
    profile: { symbol: "BBB", name: "Beta Inc", marketCap: 40_000_000_000, peRatio: 95, profitMargin: 0.05, eps: 1 },
    news: [makeNews({ title: "Beta Inc guidance update for next quarter", url: "https://example.com/b" })],
  });
  const thesisA = buildOpportunityThesis(stockA, []);
  const thesisB = buildOpportunityThesis(stockB, []);

  assert(thesisA.keyMetric !== thesisB.keyMetric, "keyMetric text differs between two stocks with different real P/E and margin");
  assert(thesisA.invalidation !== thesisB.invalidation, "invalidation text differs between two stocks with different real risk triggers");
  assert(thesisA.whatChanged !== thesisB.whatChanged, "whatChanged text differs (different real headlines)");
  assert(thesisA.mainRisk !== thesisB.mainRisk, "mainRisk text differs (never both fall back to the same generic market-risk line)");

  // Two stable, low-volatility mega-caps with only positive news (the exact
  // scenario that used to collapse to the identical generic risk line) must
  // still get distinct, real-number-driven main risks.
  const stableA = makeStock({
    ticker: "STA",
    changePercent: 1,
    profile: { symbol: "STA", name: "Stable A", marketCap: 900_000_000_000, peRatio: 30, profitMargin: 0.35, eps: 6 },
    news: [makeNews({ title: "Stable A announces new product launch", url: "https://example.com/sa" })],
  });
  const stableB = makeStock({
    ticker: "STB",
    changePercent: 1.5,
    profile: { symbol: "STB", name: "Stable B", marketCap: 700_000_000_000, peRatio: 22, profitMargin: 0.4, eps: 8 },
    news: [makeNews({ title: "Stable B announces guidance update", url: "https://example.com/sb" })],
  });
  const thesisStableA = buildOpportunityThesis(stableA, []);
  const thesisStableB = buildOpportunityThesis(stableB, []);
  assert(
    thesisStableA.mainRisk !== thesisStableB.mainRisk,
    "two stable low-volatility mega-caps with only positive news still get distinct mainRisk text (P/E-driven, not the old generic fallback)"
  );

  // Deeper fallback chain: even stocks missing P/E AND profit margin must
  // still get distinct mainRisk text (sector/market-cap or volume driven).
  const noPeNoMargin1 = makeStock({
    ticker: "NPM1",
    volume: 2_000_000,
    profile: { symbol: "NPM1", name: "No PE One", marketCap: 300_000_000_000, sector: "HEALTHCARE" },
  });
  const noPeNoMargin2 = makeStock({
    ticker: "NPM2",
    volume: 9_000_000,
    profile: { symbol: "NPM2", name: "No PE Two", marketCap: 150_000_000_000, sector: "ENERGY" },
  });
  const thesisNPM1 = buildOpportunityThesis(noPeNoMargin1, []);
  const thesisNPM2 = buildOpportunityThesis(noPeNoMargin2, []);
  assert(
    thesisNPM1.mainRisk !== thesisNPM2.mainRisk,
    "stocks with no P/E or margin still get distinct mainRisk via market cap + sector"
  );

  // Last-resort case: no P/E, no margin, no market cap, no sector – only
  // volume differs. Must still not collapse to byte-identical text.
  const bareA = makeStock({ ticker: "BAREA", volume: 500_000, profile: { symbol: "BAREA", name: "Bare A" } });
  const bareB = makeStock({ ticker: "BAREB", volume: 4_200_000, profile: { symbol: "BAREB", name: "Bare B" } });
  const thesisBareA = buildOpportunityThesis(bareA, []);
  const thesisBareB = buildOpportunityThesis(bareB, []);
  assert(
    thesisBareA.mainRisk !== thesisBareB.mainRisk,
    "even the last-resort fallback (no PE/margin/marketCap/sector) differs by real trading volume"
  );
}

// ===== Priority 4/5 regression: a Top Opportunity's "why today" must never
// quote a low-value headline, even when it's the ONLY/first news item =====
{
  const stockWithOnlyInstitutionalNews = makeStock({
    ticker: "CCC",
    news: [
      makeNews({
        title: "Lipe & Dalton Has $4.38 Million Position in Amazon.com, Inc. $AMZN",
        url: "https://example.com/c1",
      }),
      makeNews({
        title: "Resona Asset Management Co. Ltd. Purchases 72,367 Shares of Amazon.com, Inc. $AMZN",
        url: "https://example.com/c2",
      }),
    ],
  });
  const thesis = buildOpportunityThesis(stockWithOnlyInstitutionalNews, []);
  assert(
    !thesis.whyToday.includes("Position in") && !thesis.whyToday.includes("Purchases"),
    "Top Opportunity 'why today' never quotes a small institutional-position headline, even when it's the only news available"
  );
  assert(
    !thesis.whatChanged.includes("Position in") && !thesis.whatChanged.includes("Purchases"),
    "Top Opportunity 'what changed' never surfaces a small institutional-position headline"
  );
}

// ===== Priority 6: 100/100 confidence is not assigned when technical data
// is unavailable, even if everything else is live =====
{
  const fullyLiveButNoTechnical = makeStock({
    ticker: "LIVEALL",
    price: 250,
    volume: 5_000_000,
    quoteSource: { source: "live" },
    profileSource: { source: "live" },
    newsSource: { source: "live" },
    news: [makeNews()],
  });
  const dq = computeDataQuality(fullyLiveButNoTechnical, "rateLimited");
  assert(dq.coverageScore === 100, "sanity: coverage is 100 when every OTHER dimension is live/complete");
  assert(dq.confidenceScore < 100, "confidence is below 100 when technical data is unavailable, even with full coverage");
  assert(!dq.excluded, "missing technical data alone never excludes the stock");

  const fullyLiveWithTechnical = computeDataQuality(fullyLiveButNoTechnical, "available");
  assert(
    fullyLiveWithTechnical.confidenceScore > dq.confidenceScore,
    "confidence is higher when technical data IS available, all else equal"
  );
}

// ===== Priority 7: Sparse Market Overview collapses instead of showing a
// mostly-"Unavailable" table (threshold = 5 valid indicators) =====
{
  const onlyThree: MarketOverviewItem[] = [
    { key: "fearGreed", label: "Fear & Greed", value: 37, changePercent: null, isProxy: false, source: { source: "live" } },
    { key: "sp500", label: "S&P 500", value: 640, changePercent: 1.1, isProxy: false, source: { source: "live" } },
    { key: "vix", label: "VIX", value: 17.6, changePercent: -2.3, isProxy: false, source: { source: "live" } },
    { key: "nasdaq", label: "NASDAQ", value: null, changePercent: null, isProxy: false, source: { source: "unavailable" } },
    { key: "gold", label: "Gold", value: null, changePercent: null, isProxy: false, source: { source: "unavailable" } },
  ];
  const visible = visibleOverviewItems(onlyThree);
  assert(visible.length === 3, "3 of 5 indicators have a real value");
  assert(visible.length < MIN_VISIBLE_INDICATORS, "3 valid indicators is below the 5-indicator collapse threshold");

  const fiveValid: MarketOverviewItem[] = [
    ...onlyThree,
    { key: "oil", label: "Oil", value: 84, changePercent: 0.5, isProxy: false, source: { source: "live" } },
    { key: "btc", label: "Bitcoin", value: 66000, changePercent: 2.1, isProxy: false, source: { source: "live" } },
  ];
  assert(visibleOverviewItems(fiveValid).length >= MIN_VISIBLE_INDICATORS, "5+ valid indicators meets the display threshold");
}

// ===== Earnings tracker/reaction: pure-function tests only (this file makes
// no live API calls) – covers stock-reaction math, trading-day/weekend
// handling, beat/miss classification, and the tracker's lifecycle/dedup
// logic. The live-fetch orchestration itself (refreshTrackedEarnings) is
// exercised implicitly by `npm run report` against real data, same as every
// other live-provider function in this codebase. =====
{
  // A real trading week: Mon 2026-08-24 through Fri 2026-08-28, then Mon
  // 2026-08-31 (Sat/Sun are simply absent, exactly like Yahoo's real feed).
  const closes: DatedClose[] = [
    { date: "2026-08-24", close: 100 },
    { date: "2026-08-25", close: 102 },
    { date: "2026-08-26", close: 101 },
    { date: "2026-08-27", close: 103 },
    { date: "2026-08-28", close: 105 }, // Friday
    { date: "2026-08-31", close: 110 }, // next trading day after the Friday
  ];

  // --- After Market reaction: baseline = earnings-day close, new = NEXT session close ---
  const postMarket = computeEarningsReaction(closes, "2026-08-26", "post-market");
  assert(
    postMarket !== null && postMarket.baselineDate === "2026-08-26" && postMarket.newDate === "2026-08-27" &&
      postMarket.baselinePrice === 101 && postMarket.newPrice === 103 && postMarket.basis === "post-market",
    `after-market reaction uses earnings-day close as baseline and the NEXT session's close as new (got ${JSON.stringify(postMarket)})`
  );
  assert(Math.abs((postMarket?.reactionPercent ?? 0) - 1.98) < 0.15, `after-market reactionPercent ~= (103-101)/101*100 (got ${postMarket?.reactionPercent})`);

  // --- Pre-Market reaction: baseline = PREVIOUS trading-day close, new = earnings-day close ---
  const preMarket = computeEarningsReaction(closes, "2026-08-26", "pre-market");
  assert(
    preMarket !== null && preMarket.baselineDate === "2026-08-25" && preMarket.newDate === "2026-08-26" &&
      preMarket.baselinePrice === 102 && preMarket.newPrice === 101 && preMarket.basis === "pre-market",
    `pre-market reaction uses the PREVIOUS trading day's close as baseline and the earnings-day close as new (got ${JSON.stringify(preMarket)})`
  );

  // --- Weekend handling / "earnings date on Friday -> next trading day Monday" ---
  const fridayAfterMarket = computeEarningsReaction(closes, "2026-08-28", "post-market");
  assert(
    fridayAfterMarket !== null && fridayAfterMarket.newDate === "2026-08-31",
    `an after-market report on a Friday correctly resolves its next session to the following Monday, skipping the weekend (got ${fridayAfterMarket?.newDate})`
  );

  // --- A nominal date that itself falls on a weekend resolves to the next real trading day ---
  const weekendNominalDate = computeEarningsReaction(closes, "2026-08-29", "pre-market"); // Saturday
  assert(
    weekendNominalDate !== null && weekendNominalDate.newDate === "2026-08-31" && weekendNominalDate.baselineDate === "2026-08-28",
    `a nominal earnings date that itself falls on a weekend resolves the "earnings day" to the next real trading day (got ${JSON.stringify(weekendNominalDate)})`
  );

  // --- Not yet computable (next/previous session doesn't exist in history yet) – never fabricated ---
  assert(computeEarningsReaction(closes, "2026-08-31", "post-market") === null, "post-market reaction is null when the next session hasn't closed yet (no data to fabricate it from)");
  assert(computeEarningsReaction(closes, "2026-08-24", "pre-market") === null, "pre-market reaction is null when there's no prior trading day in history");
  assert(computeEarningsReaction(closes, "2026-08-26", "unknown") === null, "an 'unknown' timing never guesses a basis – always null");
  assert(computeEarningsReaction(null, "2026-08-26", "post-market") === null, "missing price history is handled safely (null, not a crash)");
  assert(computeEarningsReaction([], "2026-08-26", "post-market") === null, "empty price history is handled safely (null, not a crash)");

  // --- EPS / revenue beat-miss classification ---
  assert(classifyBeatMiss(computeSurprisePct(1.08, 1.01)) === "beat", "EPS actual > estimate -> 'beat'");
  assert(classifyBeatMiss(computeSurprisePct(0.9, 1.01)) === "miss", "EPS actual < estimate -> 'miss'");
  assert(classifyBeatMiss(computeSurprisePct(1.0, 1.0)) === "inline", "EPS actual == estimate -> 'inline'");
  assert(classifyBeatMiss(computeSurprisePct(undefined, 1.01)) === "unavailable", "missing actual EPS -> 'unavailable', never fabricated");
  assert(classifyBeatMiss(computeSurprisePct(46_700_000_000, 45_900_000_000)) === "beat", "revenue actual > estimate -> 'beat'");
  assert(classifyBeatMiss(computeSurprisePct(40_000_000_000, 45_900_000_000)) === "miss", "revenue actual < estimate -> 'miss'");
  assert(classifyBeatMiss(computeSurprisePct(45_900_000_000, undefined)) === "unavailable", "missing expected revenue -> 'unavailable', never fabricated");

  // --- Deterministic interpretation, from real numbers only ---
  const strongReaction = { baselineDate: "a", baselinePrice: 100, newDate: "b", newPrice: 104, reactionPercent: 4, basis: "post-market" as const };
  const weakReaction = { baselineDate: "a", baselinePrice: 100, newDate: "b", newPrice: 96, reactionPercent: -4, basis: "post-market" as const };
  assert(
    buildInterpretation({ epsStatus: "available", epsSurprisePct: 5, revenueStatus: "available", revenueSurprisePct: 3, reaction: strongReaction }) ===
      "Strong report with positive market confirmation.",
    "beat EPS + beat revenue + positive reaction -> the exact documented sentence"
  );
  assert(
    buildInterpretation({ epsStatus: "available", epsSurprisePct: 5, revenueStatus: "available", revenueSurprisePct: 3, reaction: weakReaction }) ===
      "Results beat estimates, but the stock fell — expectations may have been higher.",
    "beat EPS + beat revenue + negative reaction -> the exact documented sentence"
  );
  assert(
    buildInterpretation({ epsStatus: "available", epsSurprisePct: -5, revenueStatus: "available", revenueSurprisePct: -3, reaction: weakReaction }) ===
      "Weak report confirmed by negative market reaction.",
    "miss EPS + miss revenue + negative reaction -> the exact documented sentence"
  );
  assert(
    buildInterpretation({ epsStatus: "available", epsSurprisePct: 5, revenueStatus: "available", revenueSurprisePct: -3, reaction: strongReaction }) ===
      "Mixed earnings result; market reaction provides the stronger signal.",
    "mixed EPS/revenue result -> the exact documented sentence"
  );
  assert(
    buildInterpretation({ epsStatus: "unavailable", epsSurprisePct: null, revenueStatus: "unavailable", revenueSurprisePct: null, reaction: null }).length > 0,
    "missing actual results are handled safely (a real sentence, not a crash or an empty string)"
  );

  // --- Tracker persistence: dedup + lifecycle (upcoming -> awaiting; reported events vanish from Upcoming) ---
  const upcomingEntry: EarningsCalendarEntry = {
    ticker: "NVDA", name: "NVIDIA", reportDate: "2026-08-26", daysRemaining: 2, urgency: "week",
    estimatedEps: 1.01, estimatedRevenue: 45_900_000_000, timeOfDay: "post-market", reasonsHebrew: [], priority: "watchlist",
  };
  let records = upsertTrackedEarnings([], [upcomingEntry], "2026-08-24T10:00:00.000Z");
  assert(records.length === 1 && records[0].status === "awaiting", "a new Upcoming Earnings Calendar entry is tracked as 'awaiting'");
  assert(records[0].firstSeenAt === "2026-08-24T10:00:00.000Z" && records[0].lastSeenAt === "2026-08-24T10:00:00.000Z", "firstSeenAt/lastSeenAt are set on first sight");

  // Same ticker + same date seen again (e.g. next day's run) -> updates the
  // SAME record (dedup), never a second one.
  records = upsertTrackedEarnings(records, [upcomingEntry], "2026-08-25T10:00:00.000Z");
  assert(records.length === 1, "seeing the same ticker+earningsDate again does not create a duplicate record");
  assert(records[0].firstSeenAt === "2026-08-24T10:00:00.000Z", "firstSeenAt is preserved across re-sightings");
  assert(records[0].lastSeenAt === "2026-08-25T10:00:00.000Z", "lastSeenAt is refreshed on each re-sighting");

  // A different report date for the same ticker is a DIFFERENT event (ticker+earningsDate identity).
  const laterEntry: EarningsCalendarEntry = { ...upcomingEntry, reportDate: "2026-11-25" };
  records = upsertTrackedEarnings(records, [laterEntry], "2026-08-25T10:00:00.000Z");
  assert(records.length === 2, "the same ticker with a DIFFERENT earnings date is tracked as a separate event (identity = ticker+earningsDate)");

  // Simulate a completed transition to "reported" (as refreshTrackedEarnings
  // would produce) and verify it disappears from Upcoming Earnings Calendar.
  const reportedRecord: EarningsTrackingRecord = {
    ...records[0],
    status: "reported",
    result: {
      status: "available", reportedDate: "2026-08-26", reportedTiming: "post-market",
      actualEps: 1.08, expectedEpsAtReport: 1.01, epsSurprisePct: 6.9,
      actualRevenue: 46_700_000_000, expectedRevenueAtReport: 45_900_000_000, revenueSurprisePct: 1.7,
      reaction: postMarket, interpretation: "Strong report with positive market confirmation.", checkedAt: "2026-08-27T10:00:00.000Z",
    },
  };
  const trackedAfterTransition = [reportedRecord, records[1]];
  const upcomingBeforeFilter = [upcomingEntry, laterEntry];
  const upcomingAfterFilter = filterOutReported(upcomingBeforeFilter, trackedAfterTransition);
  assert(
    upcomingAfterFilter.length === 1 && upcomingAfterFilter[0].reportDate === "2026-11-25",
    "an event that transitioned to 'reported' is removed from Upcoming Earnings Calendar – it can never render as both upcoming and reported"
  );

  // --- 90-day retention + display window (last 5 trading days, max 8) ---
  const oldRecord: EarningsTrackingRecord = { ...reportedRecord, ticker: "OLD", earningsDate: "2026-01-01" };
  const pruned = pruneOldRecords([reportedRecord, oldRecord], "2026-08-27");
  assert(
    pruned.some((r) => r.ticker === "NVDA") && !pruned.some((r) => r.ticker === "OLD"),
    "a record more than 90 days past its earnings date is pruned from the store; a recent one is kept"
  );

  const withinDisplayWindow = selectDisplayRecords([reportedRecord], "2026-08-27"); // 1 day after the report
  assert(withinDisplayWindow.length === 1, "a company that reported 1 day ago is shown in the Earnings Follow-up display window");
  const tooOldForDisplay: EarningsTrackingRecord = {
    ...reportedRecord,
    ticker: "STALE",
    earningsDate: "2026-08-01",
    result: { ...reportedRecord.result!, reportedDate: "2026-08-01" },
  };
  const outsideDisplayWindow = selectDisplayRecords([tooOldForDisplay], "2026-08-27"); // ~26 days later, far past 5 trading days
  assert(outsideDisplayWindow.length === 0, "a company that reported well over 5 trading days ago is excluded from the display window (still retained in the 90-day store)");
}

// ===== Report consistency: the HTML attachment, Markdown attachment, HTML
// email body and plain-text email body must all be built from the SAME
// ReportData object – this is the deterministic gate that replaces the old
// email.ts duplicated-template bug. =====
{
  const opp = makeStock({
    ticker: "OPP1",
    tier: "core",
    finalScore: 8.5,
    profile: { symbol: "OPP1", name: "Opportunity One", marketCap: 500_000_000_000 },
  });
  const baseData: ReportData = {
    generatedAt: "2026-08-07T13:00:00.000Z",
    marketStory: null,
    additionalHeadlines: [],
    core: [opp],
    growth: [],
    speculative: [],
    topOpportunities: [opp],
    emergencyWatch: [],
    topOpportunitiesEmergencyMode: false,
    reportQuality: GOOD_QUALITY,
    belowSendThreshold: false,
    opportunityTheses: new Map(),
    watchlist: [opp],
    technicalWatch: [],
    technicalAlerts: {
      aboveUpper: [],
      belowLower: [],
      closestToUpper: [],
      closestToLower: [],
      expansion: [],
      dataUnavailable: true,
    },
    status: {
      movers: { source: "live" },
      enriched: { source: "live" },
      rateLimitHit: false,
      notes: [],
      liveCount: 3,
      cachedCount: 1,
      missingCount: 0,
    },
    scanned: 10,
    qualified: 3,
    fearGreed: null,
    earningsCalendar: [
      {
        ticker: "OPP1",
        name: "Opportunity One",
        reportDate: "2026-08-05",
        daysRemaining: 7,
        urgency: "week",
        reasonsHebrew: ["צמיחת הכנסות"],
        priority: "topOpportunity",
      },
    ],
    earningsCalendarStatus: "confirmed",
    marketCatalyst: { catalyst: null, status: "noneFound" },
    marketOverview: [],
    earningsFollowUp: { entries: [], status: "noneFound", coverage: ZERO_EARNINGS_COVERAGE },
    dividends: [],
    dividendsStatus: "confirmed",
    weekAhead: {
      earnings: [],
      earningsStatus: "noneFound",
      economicReadings: [],
      economicUnavailableCount: 0,
      unavailableNoticeHebrew: "",
    },
  };

  const today = "2026-07-29";
  const htmlAttachment = generateHtmlReport(baseData);
  const mdAttachment = generateReport(baseData);
  const emailHtml = generateEmailHtmlBody(baseData, today);
  const emailText = generateEmailTextBody(baseData, today);

  const clean = validateReportConsistency({ data: baseData, htmlAttachment, mdAttachment, emailHtml, emailText });
  assert(clean.length === 0, `all four outputs built from the same ReportData -> zero consistency violations (got: ${clean.join(" | ")})`);

  // Regression guard: the old email.ts hard-coded these exact headings.
  const staleEmailHtml = emailHtml.replace(
    ">Top Opportunities<",
    ">Core Opportunities<"
  );
  const obsoleteHeadingViolations = validateReportConsistency({
    data: baseData,
    htmlAttachment,
    mdAttachment,
    emailHtml: staleEmailHtml,
    emailText,
  });
  assert(
    obsoleteHeadingViolations.some((v) => v.includes("Core Opportunities")),
    "an obsolete 'Core Opportunities' heading reintroduced into the email HTML is caught"
  );

  // Regression guard: earnings calendar reaching the attachment but not the email.
  const missingEarningsEmailHtml = emailHtml.replaceAll("OPP1", "REDACTED");
  const missingEarningsViolations = validateReportConsistency({
    data: baseData,
    htmlAttachment,
    mdAttachment,
    emailHtml: missingEarningsEmailHtml,
    emailText,
  });
  assert(
    missingEarningsViolations.some((v) => v.includes("Upcoming Earnings Calendar")),
    "an Upcoming Earnings Calendar entry present in the HTML attachment but missing from the email body is caught"
  );

  // Regression guard: email rendered from a DIFFERENT ReportData object
  // (e.g. a stale/cached run) must fail the fingerprint check even if it
  // superficially looks fine.
  const otherOpp = makeStock({ ticker: "DIFFERENT", tier: "core", finalScore: 7 });
  const differentData: ReportData = { ...baseData, topOpportunities: [otherOpp], core: [otherOpp] };
  const emailFromDifferentData = generateEmailHtmlBody(differentData, today);
  const emailTextFromDifferentData = generateEmailTextBody(differentData, today);
  const differentObjectViolations = validateReportConsistency({
    data: baseData,
    htmlAttachment,
    mdAttachment,
    emailHtml: emailFromDifferentData,
    emailText: emailTextFromDifferentData,
  });
  assert(
    differentObjectViolations.some((v) => v.includes("different report-data object")),
    "an email rendered from a different ReportData object than the attachments is caught via the fingerprint mismatch"
  );
}

// ===== Rendering pipeline: single-ReportData-instance guarantee =====
//
// Directly targets the reported bug class: an email showing "no upcoming
// earnings" / an old catalyst while the HTML attachment, from the SAME run,
// showed real current data. Proves (a) all four outputs carry an identical,
// human-readable provenance tag (date/earnings-count/quality/first-ticker)
// when genuinely rendered from one ReportData, and (b) validateReportConsistency
// catches it immediately if even one renderer is ever fed different data.
{
  const freshEarnings = [
    { ticker: "VST", name: "Vistra Corp", reportDate: "2026-08-07", daysRemaining: 0, urgency: "today" as const, reasonsHebrew: [], priority: "megaCap" as const },
    { ticker: "TTWO", name: "Take-Two Interactive", reportDate: "2026-08-07", daysRemaining: 0, urgency: "today" as const, reasonsHebrew: [], priority: "megaCap" as const },
  ];
  const topOpp = makeStock({ ticker: "AAA", finalScore: 8, dataQuality: makeDQ() });
  const freshData = makeReportData({
    generatedAt: "2026-08-07T13:00:00.000Z",
    earningsCalendar: freshEarnings,
    earningsCalendarStatus: "confirmed",
    topOpportunities: [topOpp],
    watchlist: [topOpp],
    reportQuality: computeReportQuality({
      earningsCalendarStatus: "confirmed",
      marketOverviewWithValue: 9,
      marketOverviewTotal: 9,
      watchlistPriceUsable: 9,
      watchlistTotal: 9,
      technicalsAvailable: 9,
      technicalsTotal: 9,
      newsAvailableCount: 9,
      newsTotal: 9,
      fundamentalsAvailableCount: 9,
      fundamentalsTotal: 9,
      topOpportunitiesConfidence: [90],
      emergencyWatchCount: 0,
      earningsFollowUpResultsFound: 0,
      earningsFollowUpResultsUnavailable: 0,
    }),
  });

  // --- (a) genuinely one ReportData -> identical provenance in all four outputs ---
  const today = "2026-08-07";
  const htmlAttachment = generateHtmlReport(freshData);
  const mdAttachment = generateReport(freshData);
  const emailHtml = generateEmailHtmlBody(freshData, today);
  const emailText = generateEmailTextBody(freshData, today);

  const expected = computeProvenance(freshData);
  assert(expected.earningsCount === 2 && expected.firstOpportunityTicker === "AAA", "sanity: the fresh fixture has the earnings/opportunity data the rest of this test expects");

  const provenances = [
    ["HTML attachment", extractProvenance(htmlAttachment)],
    ["Markdown attachment", extractProvenance(mdAttachment)],
    ["Email HTML body", extractProvenance(emailHtml)],
    ["Email text body", extractProvenance(emailText)],
  ] as const;
  for (const [label, found] of provenances) {
    assert(found !== null, `${label} embeds a report-provenance tag`);
  }
  const distinctProvenances = new Set(provenances.map(([, found]) => found));
  assert(
    distinctProvenances.size === 1,
    `all four outputs embed the IDENTICAL provenance tag when genuinely rendered from one ReportData (got: ${[...distinctProvenances].join(" | ")})`
  );

  const consistent = validateReportConsistency({ data: freshData, htmlAttachment, mdAttachment, emailHtml, emailText });
  assert(consistent.length === 0, `a genuinely single-ReportData run has zero consistency violations (got: ${consistent.join(" | ")})`);

  // --- (b) reproduce the reported bug directly: email rendered from STALE
  // data (0 earnings, no catalyst, different top opportunity) while the
  // attachments come from the current run's fresh data ---
  const staleData = makeReportData({
    generatedAt: "2026-08-06T13:00:00.000Z",
    earningsCalendar: [],
    earningsCalendarStatus: "noneFound",
    topOpportunities: [],
  });
  const staleEmailHtml = generateEmailHtmlBody(staleData, "2026-08-06");
  const staleEmailText = generateEmailTextBody(staleData, "2026-08-06");
  const staleViolations = validateReportConsistency({
    data: freshData, // the current run's actual data
    htmlAttachment,
    mdAttachment,
    emailHtml: staleEmailHtml,
    emailText: staleEmailText,
  });
  assert(
    staleViolations.some((v) => v.includes("Email HTML body") && v.includes("stale or different data")),
    "an email rendered from stale data (0 earnings, no top opportunity) while attachments show fresh data (10-style earnings, real opportunity) is caught by the provenance check"
  );
  assert(
    staleViolations.some((v) => v.includes(`earnings=${expected.earningsCount}`)),
    "the caught violation names the EXPECTED earnings count from the current run, making the mismatch immediately diagnosable"
  );
}

// ===== Market Overview value formatting: Fear & Greed and VIX must never
// render with a "$" prefix (they're an index/score, not a price); percent
// units and real per-unit prices are unaffected. =====
{
  const fearGreedItem: MarketOverviewItem = { key: "fearGreed", label: "Fear & Greed Index", value: 34, changePercent: null, isProxy: false, source: { source: "live" } };
  const vixItem: MarketOverviewItem = { key: "vix", label: "VIX", value: 19.51, changePercent: 5.01, isProxy: false, source: { source: "live" } };
  const yieldItem: MarketOverviewItem = { key: "treasuryYield10y", label: "US 10-Year Treasury Yield", value: 4.62, changePercent: null, unit: "%", isProxy: false, source: { source: "live" } };
  const priceItem: MarketOverviewItem = { key: "sp500", label: "S&P 500 (SPY)", value: 729.46, changePercent: -2.4, isProxy: false, source: { source: "live" } };

  assert(formatOverviewValue(fearGreedItem) === "34", `Fear & Greed Index renders as a bare number, not currency (got "${formatOverviewValue(fearGreedItem)}")`);
  assert(formatOverviewValue(vixItem) === "19.51", `VIX renders as a bare number, not currency (got "${formatOverviewValue(vixItem)}")`);
  assert(formatOverviewValue(yieldItem) === "4.62%", `Treasury yield renders as a percentage (got "${formatOverviewValue(yieldItem)}")`);
  assert(formatOverviewValue(priceItem) === "$729.46", `a real per-unit price (S&P 500 / SPY) still renders with "$" (got "${formatOverviewValue(priceItem)}")`);
}

// ===== Presentation redesign: the HTML attachment and HTML email body use
// the required visual structure (structured earnings rows, metric tiles,
// N separate opportunity cards, diagnostics last, no currency-formatted
// index values, RTL container, no duplicated "This Week To Watch" earnings
// when it would only repeat the calendar). =====
{
  const oppA = makeStock({
    ticker: "OPPA",
    tier: "core",
    finalScore: 8.2,
    changePercent: 1.5,
    profile: { symbol: "OPPA", name: "Opportunity A", marketCap: 600_000_000_000 },
  });
  const oppB = makeStock({
    ticker: "OPPB",
    tier: "growth",
    finalScore: 7.1,
    changePercent: -0.8,
    profile: { symbol: "OPPB", name: "Opportunity B", marketCap: 90_000_000_000 },
  });

  const richData: ReportData = {
    generatedAt: "2026-08-07T13:00:00.000Z",
    marketStory: null,
    additionalHeadlines: [],
    core: [oppA],
    growth: [oppB],
    speculative: [],
    topOpportunities: [oppA, oppB],
    emergencyWatch: [],
    topOpportunitiesEmergencyMode: false,
    reportQuality: GOOD_QUALITY,
    belowSendThreshold: false,
    opportunityTheses: new Map(),
    watchlist: [oppA, oppB],
    technicalWatch: [
      { ticker: "OPPA", name: "Opportunity A", price: 120, changePercent: 1.5, isLastClose: false, rsi14: 55, statusHebrew: "ניטרלי" },
      { ticker: "OPPB", name: "Opportunity B", price: 0, changePercent: 0, isLastClose: false, rsi14: null, statusHebrew: "לא זמין" },
    ],
    technicalAlerts: {
      aboveUpper: [],
      belowLower: [],
      closestToUpper: [],
      closestToLower: [],
      expansion: [],
      dataUnavailable: false,
    },
    status: {
      movers: { source: "live" },
      enriched: { source: "live" },
      rateLimitHit: false,
      notes: [],
      liveCount: 3,
      cachedCount: 22,
      missingCount: 19,
    },
    scanned: 60,
    qualified: 9,
    fearGreed: { score: 34, rating: "fear", classification: "Fear", hebrew: "שוק במצב פחד" },
    earningsCalendar: [
      {
        ticker: "OPPA",
        name: "Opportunity A",
        reportDate: "2026-08-01",
        daysRemaining: 3,
        urgency: "week",
        reasonsHebrew: ["צמיחת הכנסות"],
        priority: "topOpportunity",
      },
    ],
    earningsCalendarStatus: "confirmed",
    marketCatalyst: { catalyst: null, status: "noneFound" },
    marketOverview: [
      { key: "fearGreed", label: "Fear & Greed Index", value: 34, changePercent: null, isProxy: false, source: { source: "live" } },
      { key: "sp500", label: "S&P 500 (SPY)", value: 729.46, changePercent: -2.4, isProxy: false, source: { source: "live" } },
      { key: "nasdaq", label: "NASDAQ (QQQ)", value: 661.73, changePercent: -6.18, isProxy: false, source: { source: "live" } },
      { key: "vix", label: "VIX", value: 19.51, changePercent: 5.01, isProxy: false, source: { source: "live" } },
      { key: "gold", label: "Gold (Futures)", value: 3400, changePercent: 0.3, isProxy: false, source: { source: "live" } },
      { key: "oil", label: "Oil – WTI (Futures)", value: 78, changePercent: -1.1, isProxy: false, source: { source: "live" } },
    ],
    earningsFollowUp: { entries: [], status: "noneFound", coverage: ZERO_EARNINGS_COVERAGE },
    dividends: [{ ticker: "OPPA", name: "Opportunity A", dividendPerShare: 2.5, dividendYieldPct: 1.8 }],
    dividendsStatus: "confirmed",
    weekAhead: {
      // Same ticker+date already shown in earningsCalendar above -> a pure
      // duplicate, must NOT be shown again.
      earnings: [
        {
          ticker: "OPPA",
          name: "Opportunity A",
          reportDate: "2026-08-01",
          daysRemaining: 3,
          urgency: "week",
          reasonsHebrew: ["צמיחת הכנסות"],
          priority: "topOpportunity",
        },
      ],
      earningsStatus: "confirmed",
      economicReadings: [{ key: "cpi", label: "CPI", value: 3.1, unit: "%", asOfDate: "2026-07-01", source: { source: "live" } }],
      economicUnavailableCount: 0,
      unavailableNoticeHebrew: "",
    },
  };

  const today = "2026-07-30";
  const htmlAttachment = generateHtmlReport(richData);
  const emailHtml = generateEmailHtmlBody(richData, today);

  const clean = validatePresentation({ data: richData, htmlAttachment, emailHtml });
  assert(clean.length === 0, `well-formed redesigned output -> zero presentation violations (got: ${clean.join(" | ")})`);

  // Regression guard: the extra earnings entry is genuinely NEW information
  // (not in earningsCalendar) -> weekAheadExtraEarnings must surface it, and
  // the rendered "This Week To Watch" must show it exactly once.
  const extraEarningsData: ReportData = {
    ...richData,
    weekAhead: {
      ...richData.weekAhead,
      earnings: [...richData.weekAhead.earnings, { ...richData.weekAhead.earnings[0], ticker: "NEWCO", name: "New Co", reportDate: "2026-08-09" }],
    },
  };
  const extra = weekAheadExtraEarnings(extraEarningsData);
  assert(extra.length === 1 && extra[0].ticker === "NEWCO", "This Week To Watch surfaces earnings genuinely absent from the Upcoming Earnings Calendar");
  const htmlWithExtra = generateHtmlReport(extraEarningsData);
  assert(/class="[^"]*\bweek-ahead-earnings\b[^"]*"/.test(htmlWithExtra) && htmlWithExtra.includes("NEWCO"), "the genuinely-new earnings entry IS rendered in This Week To Watch");

  // Regression guard: max-width container removed from the email.
  const noMaxWidthEmail = emailHtml.replace(`max-width:${EMAIL_MAX_WIDTH}px`, "max-width:none");
  const maxWidthViolations = validatePresentation({ data: richData, htmlAttachment, emailHtml: noMaxWidthEmail });
  assert(maxWidthViolations.some((v) => v.includes("max-width")), "a missing ~680px max-width container on the email is caught");

  // Regression guard: VIX rendered with a "$" prefix (the old bug) is caught.
  const currencyBugEmail = emailHtml.replace(
    /data-metric-value-key="vix"([^>]*)>([^<]*)</,
    (_m, attrs, value) => `data-metric-value-key="vix"${attrs}>$${value}<`
  );
  const currencyViolations = validatePresentation({ data: richData, htmlAttachment, emailHtml: currencyBugEmail });
  assert(currencyViolations.some((v) => v.includes("vix") && v.includes("currency")), "VIX rendered with a \"$\" prefix is caught");

  // Regression guard: no dir="rtl" container.
  const noRtlHtml = htmlAttachment.replace(/dir="rtl"/g, "");
  const rtlViolations = validatePresentation({ data: richData, htmlAttachment: noRtlHtml, emailHtml });
  assert(rtlViolations.some((v) => v.includes('dir="rtl"')), "a missing dir=\"rtl\" container on the HTML attachment is caught");

  // Regression guard: a duplicated "This Week To Watch" earnings block
  // reappearing when it would only repeat the calendar is caught. (In
  // richData, weekAhead.earnings duplicates earningsCalendar exactly, so the
  // clean htmlAttachment must contain no "week-ahead-earnings" marker at
  // all – reinsert one to prove the check actually fires.)
  assert(!/class="[^"]*\bweek-ahead-earnings\b[^"]*"/.test(htmlAttachment), "sanity: the clean attachment has no duplicated earnings block to begin with");
  const duplicatedWeekAheadHtml = htmlAttachment.replace(
    '<div class="diagnostics-card">',
    '<div class="week-ahead-earnings">duplicate</div><div class="diagnostics-card">'
  );
  const dedupViolations = validatePresentation({ data: richData, htmlAttachment: duplicatedWeekAheadHtml, emailHtml });
  assert(dedupViolations.some((v) => v.includes("duplicated This Week To Watch")), "a reintroduced duplicate This Week To Watch earnings block is caught");
}

// ===== Emergency Report Mode: safety validation =====
{
  // --- 1. Provider failure alone must never silently remove a valid candidate ---
  const moverStock = makeStock({ ticker: "NEWCO", price: 42, changePercent: 3, origin: "mover" });
  assert(
    passesLongTermFilter(moverStock, undefined, /* profileFetchFailed */ true) === true,
    "provider failure (profile fetch failed) does not silently remove a valid candidate"
  );
  assert(
    passesLongTermFilter(moverStock, undefined, /* profileFetchFailed */ false) === false,
    "a profile that was actually fetched (live/cached) and came back empty is still excluded – not the same as a provider failure"
  );

  // --- 2. Missing current/cached price still excludes the candidate ---
  const noPriceStock = makeStock({ ticker: "NOPRICE", price: 0 });
  const noPriceResult = passesEmergencySafetyFilter(noPriceStock);
  assert(noPriceResult.ok === false && !!noPriceResult.reason?.includes("price"), "missing current/cached price still excludes an Emergency Mode candidate");

  // --- 3. Penny / OTC / warrant rules still apply under Emergency Mode ---
  const warrantStock = makeStock({ ticker: "ABCDW", price: 15 });
  assert(passesEmergencySafetyFilter(warrantStock).ok === false, "a warrant ticker is still excluded under Emergency Mode");
  const otcStock = makeStock({ ticker: "ABCDF", price: 15 });
  assert(passesEmergencySafetyFilter(otcStock).ok === false, "a likely-OTC ticker is still excluded under Emergency Mode");
  const pennyStock = makeStock({ ticker: "PENNY", price: 2 });
  assert(passesEmergencySafetyFilter(pennyStock).ok === false, "below-minimum-price penny stock is still excluded under Emergency Mode");

  // --- 4. A confirmed material negative fundamental event still excludes the candidate ---
  const bankruptStock = makeStock({
    ticker: "BKRT",
    price: 30,
    news: [makeNews({ title: "BKRT Files for Chapter 11 Bankruptcy Protection" })],
  });
  const bankruptResult = passesEmergencySafetyFilter(bankruptStock);
  assert(
    bankruptResult.ok === false && !!bankruptResult.reason?.includes("material negative"),
    "a confirmed material negative fundamental event (e.g. bankruptcy filing) still excludes the candidate under Emergency Mode"
  );
  // A safe candidate with ordinary (non-material) negative news is NOT excluded by this rule.
  const routineDipStock = makeStock({
    ticker: "DIP",
    price: 30,
    news: [makeNews({ title: "DIP shares decline after modest earnings miss" })],
  });
  assert(passesEmergencySafetyFilter(routineDipStock).ok === true, "routine negative news (a miss/decline) is NOT treated as a material negative event");

  // --- 5. buildTopOpportunities: normal mode is used automatically when adequate data coverage exists ---
  // makeStock's default profile already carries marketCap+eps+profitMargin (3
  // fundamentals) and a name, so it clears the stricter normal bar (>=2
  // fundamentals + identity) without extra overrides.
  const goodCandidate = makeStock({ ticker: "GOOD", price: 100, finalScore: 8, dataQuality: makeDQ() });
  const weakCandidate = makeStock({ ticker: "WEAK", price: 50, finalScore: 5, dataQuality: makeDQ({ label: "Low", coverageScore: 40, confidenceScore: 30 }) });
  const normalResult = buildTopOpportunities([goodCandidate, weakCandidate], 3);
  assert(normalResult.emergencyModeActive === false, "normal mode is used automatically when at least one candidate meets the quality bar");
  assert(normalResult.emergencyWatch.length === 0, "emergencyWatch stays empty when normal mode is used");
  assert(
    normalResult.topOpportunities.length === 1 && normalResult.topOpportunities[0].ticker === "GOOD",
    "normal mode only includes candidates that actually clear the quality bar"
  );

  // --- 5a. Missing OPTIONAL fundamentals (P/E, EPS, margin) must reduce
  // confidence, never eliminate an otherwise strong, well-covered candidate
  // (root cause of the 2026-08-28 "Top Opportunities: none" incident, where
  // a single Alpha Vantage OVERVIEW rate-limit hit zeroed out 17 qualified
  // candidates at once via a hard fundamentals-count gate). ---
  const thinFundamentalsCandidate = makeStock({
    ticker: "THIN",
    price: 80,
    finalScore: 7.5,
    dataQuality: makeDQ(), // High label, full coverage...
    profile: { symbol: "THIN", name: "Thin Fundamentals Co" }, // ...but only "name" – zero of marketCap/PE/EPS/margin
  });
  const thinResult = buildTopOpportunities([thinFundamentalsCandidate], 3);
  assert(
    thinResult.topOpportunities.length === 1 && thinResult.topOpportunities[0].ticker === "THIN",
    "a High-coverage stock with missing OPTIONAL fundamentals (P/E, EPS, margin) still clears the normal Top " +
      "Opportunity bar – mandatory data only, optional enrichment reduces confidence instead"
  );

  const richFundamentalsCandidate = makeStock({
    ticker: "RICH",
    price: 80,
    finalScore: 7.5,
    dataQuality: makeDQ(),
    profile: { symbol: "RICH", name: "Rich Fundamentals Co", marketCap: 5_000_000_000, peRatio: 22, eps: 3.1, profitMargin: 0.18 },
  });
  const richDQ = computeDataQuality(richFundamentalsCandidate, "available");
  const thinDQ = computeDataQuality(thinFundamentalsCandidate, "available");
  assert(
    thinDQ.confidenceScore < richDQ.confidenceScore,
    `missing optional fundamentals lowers confidence (thin=${thinDQ.confidenceScore}) relative to full fundamentals (rich=${richDQ.confidenceScore}), without excluding the candidate`
  );
  assert(!thinDQ.excluded, "missing optional fundamentals alone never excludes a candidate with a usable price");

  // --- 5b. buildTopOpportunities: Emergency Mode engages only when NOTHING clears the bar,
  // and fills emergencyWatch, never topOpportunities ---
  const degradedA = makeStock({
    ticker: "DEGA",
    price: 60,
    finalScore: 7,
    dataQuality: makeDQ({ label: "Low", coverageScore: 40, confidenceScore: 25, excluded: false }),
  });
  const degradedNoPrice = makeStock({
    ticker: "DEGB",
    price: 0,
    finalScore: 9, // best score, but MUST be excluded – no usable price
    dataQuality: makeDQ({ label: "Low", coverageScore: 20, confidenceScore: 10, excluded: true }),
  });
  const degradedBankrupt = makeStock({
    ticker: "DEGC",
    price: 20,
    finalScore: 8.5, // second-best score, but MUST be excluded – confirmed bad news
    dataQuality: makeDQ({ label: "Low", coverageScore: 40, confidenceScore: 25 }),
    news: [makeNews({ title: "DEGC warns of going concern doubt in latest filing" })],
  });
  const emergencyResult = buildTopOpportunities([degradedNoPrice, degradedBankrupt, degradedA], 3);
  assert(emergencyResult.emergencyModeActive === true, "Emergency Report Mode activates when no candidate clears the normal quality bar");
  assert(emergencyResult.topOpportunities.length === 0, "Emergency Mode NEVER populates topOpportunities – only emergencyWatch");
  assert(
    emergencyResult.emergencyWatch.length === 1 && emergencyResult.emergencyWatch[0].ticker === "DEGA",
    "Emergency Mode still excludes the no-price and confirmed-bad-news candidates even though they scored higher"
  );
  assert(
    emergencyResult.emergencyWatch.every((s) => s.emergencyMode === true),
    "every stock promoted through Emergency Mode is explicitly tagged emergencyMode: true"
  );
  assert(
    emergencyResult.emergencyWatch[0].emergencyMode === true && degradedA.emergencyMode === undefined,
    "Emergency Mode never presents a stock as a normal high-confidence pick – it returns a tagged copy, the original candidate object is untouched"
  );

  // A run with literally no safety-passing candidate at all stays empty rather than fabricating a pick.
  const allUnsafe = buildTopOpportunities([degradedNoPrice, degradedBankrupt], 3);
  assert(
    allUnsafe.topOpportunities.length === 0 && allUnsafe.emergencyWatch.length === 0 && allUnsafe.emergencyModeActive === false,
    "Emergency Mode never fabricates a candidate when literally nothing passes the safety filter"
  );

  // --- 6. Emergency Watch candidates are visibly marked, and rendered in their
  // OWN section, across all four render surfaces – never inside Top Opportunities ---
  const emergencyStock = emergencyResult.emergencyWatch[0];
  const emergencyReportData = makeReportData({
    topOpportunities: [],
    emergencyWatch: [emergencyStock],
    topOpportunitiesEmergencyMode: true,
    watchlist: [emergencyStock],
  });
  const emMd = generateReport(emergencyReportData);
  const emHtml = generateHtmlReport(emergencyReportData);
  const emEmailHtml = generateEmailHtmlBody(emergencyReportData, "2026-08-07");
  const emEmailText = generateEmailTextBody(emergencyReportData, "2026-08-07");
  assert(emMd.includes(EMERGENCY_MODE_LABEL), "Markdown attachment visibly labels the Emergency Watch candidate");
  assert(emHtml.includes(EMERGENCY_MODE_LABEL), "HTML attachment visibly labels the Emergency Watch candidate");
  assert(emEmailHtml.includes(EMERGENCY_MODE_LABEL), "Email HTML body visibly labels the Emergency Watch candidate");
  assert(emEmailText.includes(EMERGENCY_MODE_LABEL), "Email text body visibly labels the Emergency Watch candidate");
  assert(emMd.includes("Reduced-Confidence Watch"), "Markdown attachment renders a distinct Reduced-Confidence Watch section");
  assert(emHtml.includes("Reduced-Confidence Watch"), "HTML attachment renders a distinct Reduced-Confidence Watch section");

  // Regression guard: a normal-mode report (no emergencyWatch entries) must
  // NEVER show the Emergency Mode label anywhere.
  const normalReportData = makeReportData({
    topOpportunities: [goodCandidate],
    emergencyWatch: [],
    topOpportunitiesEmergencyMode: false,
    watchlist: [goodCandidate],
  });
  const normalMd = generateReport(normalReportData);
  const normalHtml = generateHtmlReport(normalReportData);
  const normalEmailHtml = generateEmailHtmlBody(normalReportData, "2026-08-07");
  const normalEmailText = generateEmailTextBody(normalReportData, "2026-08-07");
  assert(
    !normalMd.includes(EMERGENCY_MODE_LABEL) &&
      !normalHtml.includes(EMERGENCY_MODE_LABEL) &&
      !normalEmailHtml.includes(EMERGENCY_MODE_LABEL) &&
      !normalEmailText.includes(EMERGENCY_MODE_LABEL),
    "a normal-mode report never shows the Emergency Mode label on a genuinely high-confidence pick"
  );
}

// ===== Full-market Earnings Calendar discovery + ranking =====
{
  const NOW_ISO = "2026-08-07";
  function rowsFor(dateIso: string, rows: NasdaqEarningsRow[] | null): { dateIso: string; rows: NasdaqEarningsRow[] | null } {
    return { dateIso, rows };
  }

  // --- a company outside the watchlist can appear in Upcoming Earnings ---
  const nonWatchlistRows = deriveEarningsCalendarFromRows(
    [rowsFor("2026-08-10", [nasdaqRow({ symbol: "COST", name: "Costco Wholesale", marketCap: 400_000_000_000 })])],
    { nowIso: NOW_ISO, enrichedByTicker: new Map() }
  );
  assert(nonWatchlistRows.status === "confirmed", "a real full-market calendar day yields status 'confirmed'");
  assert(
    nonWatchlistRows.entries.some((e) => e.ticker === "COST"),
    "a company outside the watchlist (COST, not in WATCHLIST) appears in Upcoming Earnings on its own merit"
  );

  // --- ranks meaningful companies from a full-market calendar: watchlist
  // first, then index-member mega-caps, obscure micro-caps excluded entirely ---
  const rankedResult = deriveEarningsCalendarFromRows(
    [
      rowsFor("2026-08-08", [
        nasdaqRow({ symbol: "PLTR", name: "Palantir Technologies", marketCap: 300_000_000_000 }), // watchlist
        nasdaqRow({ symbol: "COST", name: "Costco Wholesale", marketCap: 400_000_000_000 }), // Nasdaq-100 member
        nasdaqRow({ symbol: "MIDCO", name: "Mid Cap Co", marketCap: 5_000_000_000 }), // qualifies via cap floor only
        nasdaqRow({ symbol: "TINYX", name: "Tiny Micro Cap", marketCap: 50_000_000 }), // below the ranking floor
      ]),
    ],
    { nowIso: NOW_ISO, enrichedByTicker: new Map() }
  );
  const rankedTickers = rankedResult.entries.map((e) => e.ticker);
  assert(rankedTickers[0] === "PLTR", "watchlist membership always ranks first, regardless of market cap");
  assert(
    rankedTickers.indexOf("COST") < rankedTickers.indexOf("MIDCO"),
    "an index-member mega-cap ranks above a non-index mid-cap of similar or smaller size"
  );
  assert(!rankedTickers.includes("TINYX"), "a micro-cap well below the ranking floor and not index/watchlist is excluded entirely – 'not every micro-cap'");

  // --- primary window too thin -> reaches into the secondary (8-14 day) window ---
  const thinPrimaryRows: Array<{ dateIso: string; rows: NasdaqEarningsRow[] | null }> = [
    rowsFor("2026-08-08", [nasdaqRow({ symbol: "ONECO", name: "One Co", marketCap: 10_000_000_000 })]),
  ];
  for (let i = 0; i < 6; i++) {
    thinPrimaryRows.push(rowsFor(`2026-08-${10 + i}`, []));
  }
  thinPrimaryRows.push(
    rowsFor("2026-08-17", [nasdaqRow({ symbol: "LATECO", name: "Late Co", marketCap: 20_000_000_000 })])
  );
  const secondaryFallback = deriveEarningsCalendarFromRows(thinPrimaryRows, { nowIso: NOW_ISO, enrichedByTicker: new Map() });
  assert(
    secondaryFallback.entries.some((e) => e.ticker === "LATECO"),
    "when the primary 0-7 day window alone is thin, the secondary 8-14 day window is used to reach a normally-useful count"
  );

  // --- provider failure vs. genuinely no earnings must never collapse into the same status ---
  const allFailed = deriveEarningsCalendarFromRows(
    [rowsFor("2026-08-08", null), rowsFor("2026-08-09", null)],
    { nowIso: NOW_ISO, enrichedByTicker: new Map() }
  );
  assert(allFailed.status === "unavailable", "every date's fetch failing across the full-market calendar -> 'unavailable', never 'no companies reporting'");
}

// ===== News relevance: ETF/leveraged-fund articles cannot become a company Market Story =====
{
  const etfNews = makeNews({
    title: "GraniteShares 2x Long PLTR Daily ETF (PLTU) Sees Unusual Options Activity",
    publishedAt: "20260807T090000",
    sentimentScore: 0.4,
    relevanceScore: 0.9,
  });
  assert(isEtfOrLeveragedFundNews(etfNews), "a leveraged-ETF headline mentioning the ticker is detected as ETF/fund news, not company news");

  const genuineNews = makeNews({
    title: "Palantir Technologies Announces New Government Contract Win",
    publishedAt: "20260807T090000",
    sentimentScore: 0.4,
    relevanceScore: 0.9,
  });
  assert(!isEtfOrLeveragedFundNews(genuineNews), "a genuine company headline is not flagged as ETF/fund news");

  const pltrStock = makeStock({
    ticker: "PLTR",
    price: 150,
    profile: { symbol: "PLTR", name: "Palantir Technologies", marketCap: 300_000_000_000, eps: 1, profitMargin: 0.2 },
    news: [etfNews], // ONLY an ETF article available – no genuine company story
  });
  const etfOnlyData: ReportData = makeReportData({ watchlist: [pltrStock] });
  const storyFromEtfOnly = selectMarketStory(etfOnlyData, Date.parse("2026-08-07T12:00:00Z"));
  assert(storyFromEtfOnly === null, "when the ONLY available news is a leveraged-ETF article, no Market Story is selected (never fabricated, never an ETF puff piece)");

  const pltrStockWithRealNews = makeStock({
    ticker: "PLTR",
    price: 150,
    profile: { symbol: "PLTR", name: "Palantir Technologies", marketCap: 300_000_000_000, eps: 1, profitMargin: 0.2 },
    news: [etfNews, genuineNews],
  });
  const mixedData: ReportData = makeReportData({ watchlist: [pltrStockWithRealNews] });
  const storyFromMixed = selectMarketStory(mixedData, Date.parse("2026-08-07T12:00:00Z"));
  assert(
    storyFromMixed !== null && storyFromMixed.headline === genuineNews.title,
    "when a genuine company story exists alongside an ETF article, the real company story wins – the ETF article never outranks it"
  );
}

// ===== Technical Watch: Last Close fallback when the quote is unavailable =====
{
  const withQuote = resolveTechnicalWatchPrice(150, 2.5, { ticker: "X", name: "X", price: 148, upper: 160, lower: 140, rsi14: 55, widthChangePct: null });
  assert(withQuote.price === 150 && withQuote.isLastClose === false, "a live/cached quote price is used as-is, not the historical close");

  const noQuoteButTechnical = resolveTechnicalWatchPrice(0, 0, { ticker: "Y", name: "Y", price: 148, upper: 160, lower: 140, rsi14: 55, widthChangePct: null });
  assert(
    noQuoteButTechnical.price === 148 && noQuoteButTechnical.isLastClose === true,
    "when the quote is unavailable but RSI/Bollinger were computed, the same dataset's latest close is used as a labeled 'Last close' fallback – never 'Price unavailable' next to a valid RSI"
  );
  assert(noQuoteButTechnical.changePercent === 0, "a Last-close fallback never fabricates a daily % change");

  const noQuoteNoTechnical = resolveTechnicalWatchPrice(0, 0, undefined);
  assert(
    noQuoteNoTechnical.price === 0 && noQuoteNoTechnical.isLastClose === false,
    "when there's genuinely no quote AND no technical history, price stays unavailable rather than fabricating a close"
  );
}

// ===== Report Quality Score: recovery trigger + poor-quality diagnostic gate =====
{
  const excellentInput = {
    earningsCalendarStatus: "confirmed" as const,
    marketOverviewWithValue: 9,
    marketOverviewTotal: 9,
    watchlistPriceUsable: 9,
    watchlistTotal: 9,
    technicalsAvailable: 9,
    technicalsTotal: 9,
    newsAvailableCount: 9,
    newsTotal: 9,
    fundamentalsAvailableCount: 9,
    fundamentalsTotal: 9,
    topOpportunitiesConfidence: [95, 90, 92],
    emergencyWatchCount: 0,
    earningsFollowUpResultsFound: 0,
    earningsFollowUpResultsUnavailable: 0,
  };
  const excellent = computeReportQuality(excellentInput);
  assert(excellent.score >= 90 && excellent.band === "Excellent", "full coverage across every dimension scores Excellent (90-100)");
  assert(excellent.score >= RECOVERY_THRESHOLD, "an Excellent-quality run never triggers the recovery pass");

  const poorInput = {
    earningsCalendarStatus: "unavailable" as const,
    marketOverviewWithValue: 1,
    marketOverviewTotal: 9,
    watchlistPriceUsable: 1,
    watchlistTotal: 9,
    technicalsAvailable: 1,
    technicalsTotal: 9,
    newsAvailableCount: 0,
    newsTotal: 9,
    fundamentalsAvailableCount: 0,
    fundamentalsTotal: 9,
    topOpportunitiesConfidence: [],
    emergencyWatchCount: 0,
    earningsFollowUpResultsFound: 0,
    earningsFollowUpResultsUnavailable: 0,
  };
  const poor = computeReportQuality(poorInput);
  assert(poor.score < RECOVERY_THRESHOLD, "a run with widespread provider failure scores below the recovery threshold");
  assert(poor.score < SEND_THRESHOLD, "a severely degraded run scores below the send threshold too");
  assert(poor.band === "Poor", "a severely degraded run is banded 'Poor'");

  // Market Story freshness: 24h primary window, 48h fallback (labeled),
  // nothing older ever qualifies. See src/marketStory.ts.
  const now = Date.parse("2026-08-07T12:00:00Z");
  const freshNews = makeNews({
    title: "Test Corp Reports Record Quarterly Earnings",
    publishedAt: "20260807T030000", // 9h before "now" – inside the 24h primary window
    sentimentScore: 0.4,
    relevanceScore: 0.9,
  });
  const fallbackNews = makeNews({
    title: "Test Corp Announces New Product Launch",
    publishedAt: "20260806T060000", // 30h before "now" – outside 24h, inside 48h fallback
    sentimentScore: 0.4,
    relevanceScore: 0.9,
  });
  const tooOldNews = makeNews({
    title: "Test Corp Signs New Supply Contract",
    publishedAt: "20260803T090000", // ~99h before "now" – outside even the 48h fallback
    sentimentScore: 0.4,
    relevanceScore: 0.9,
  });

  const freshStory = selectMarketStory(
    makeReportData({ watchlist: [makeStock({ ticker: "FRESH", price: 50, news: [freshNews] })] }),
    now
  );
  assert(
    freshStory !== null && freshStory.isFallback === false,
    "a story inside the 24h primary window is used directly, not marked as fallback"
  );

  const fallbackData: ReportData = makeReportData({
    watchlist: [makeStock({ ticker: "FALLBACK", price: 50, news: [fallbackNews] })],
  });
  const primaryMiss = selectMarketStory(fallbackData, now);
  assert(primaryMiss === null, "sanity: a 30h-old story is genuinely outside the 24h primary window");
  const recoveredStory = selectMarketStory(fallbackData, now, 48);
  assert(
    recoveredStory !== null && recoveredStory.headline === fallbackNews.title && recoveredStory.isFallback === true,
    "the 48h fallback window finds a real story the 24h primary window missed, and tags it isFallback"
  );

  const tooOldStory = selectMarketStory(
    makeReportData({ watchlist: [makeStock({ ticker: "TOOOLD", price: 50, news: [tooOldNews] })] }),
    now,
    48
  );
  assert(tooOldStory === null, "a story older than the 48h fallback window never qualifies, even as a fallback");

  // Poor-quality reports do not masquerade as normal reports.
  const goodCandidate = makeStock({ ticker: "GOOD", price: 100, finalScore: 8, dataQuality: makeDQ() });
  const poorReportData: ReportData = makeReportData({
    topOpportunities: [goodCandidate],
    watchlist: [goodCandidate],
    reportQuality: poor,
    belowSendThreshold: true,
  });
  const diagMd = generateDiagnosticReport(poorReportData);
  const diagHtml = generateDiagnosticHtmlReport(poorReportData);
  const diagEmailHtml = generateEmailHtmlBody(poorReportData, "2026-08-07");
  const diagEmailText = generateEmailTextBody(poorReportData, "2026-08-07");
  assert(diagMd.includes("לא הופק ברמת האיכות הרגילה"), "the diagnostic Markdown report clearly states normal quality wasn't reached");
  assert(diagHtml.includes("לא הופק ברמת האיכות הרגילה"), "the diagnostic HTML report clearly states normal quality wasn't reached");
  assert(
    diagEmailHtml.includes("לא הופק ברמת האיכות הרגילה") && diagEmailText.includes("לא הופק ברמת האיכות הרגילה"),
    "generateEmailHtmlBody/generateEmailTextBody automatically switch to the diagnostic body when belowSendThreshold is true"
  );
  assert(
    !diagEmailHtml.includes("Top Opportunities") && !diagEmailText.includes("🎯 Top Opportunities"),
    "a poor-quality diagnostic email never renders the normal Top Opportunities section, even though goodCandidate would have qualified"
  );

  // Visual structure remains intact: the normal report still carries its
  // approved-design markers, and the diagnostic report still uses the same
  // shell (navy header / RTL / card system), not a bare-bones page.
  const goodReportData: ReportData = makeReportData({
    topOpportunities: [goodCandidate],
    watchlist: [goodCandidate],
    reportQuality: excellent,
    belowSendThreshold: false,
  });
  const normalHtmlFull = generateHtmlReport(goodReportData);
  assert(normalHtmlFull.includes('dir="rtl"') && normalHtmlFull.includes("Top Opportunities"), "a normal-quality HTML report preserves the RTL layout and the Top Opportunities section");
  assert(diagHtml.includes('dir="rtl"') && diagHtml.includes("report-header"), "the diagnostic HTML report reuses the same RTL/header visual shell as the normal report, not a stripped-down page");
}

// ===== 2026-08-28 regression: scheduled report cannot be silently sent
// hours late as "pre-market" (root cause: GitHub's scheduler fired the
// workflow ~9h50m after its target, landing the email at 02:04 IDT). =====
{
  // Weekday US market-time reference points (2026-08-28 is a Friday).
  const preMarketNy = new Date("2026-08-28T13:15:00Z"); // ~09:15 ET (before 09:30 open)
  const openNy = new Date("2026-08-28T15:00:00Z"); // ~11:00 ET (regular session)
  const afterHoursNy = new Date("2026-08-29T02:00:00Z"); // ~22:00 ET the prior evening – market long closed
  const weekendNy = new Date("2026-08-30T15:00:00Z"); // Saturday, regular-session UTC hour

  assert(usMarketState(preMarketNy) === "pre-market", "sanity: the pre-market fixture is genuinely before the US open");
  assert(usMarketState(openNy) === "open", "sanity: the open fixture is genuinely inside the US regular session");
  assert(usMarketState(afterHoursNy) === "after-hours", "sanity: the after-hours fixture is genuinely after the US close");
  assert(usMarketState(weekendNy) === "weekend", "sanity: the weekend fixture is genuinely a Saturday");

  const onTime = classifyReportTiming({
    now: preMarketNy,
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 5,
    isManualRun: false,
  });
  assert(onTime.status === "onTime", `a run starting inside the target pre-market window is classified onTime (got ${onTime.status})`);

  const stillPreMarketButLate = new Date(preMarketNy.getTime() + (DELAYED_THRESHOLD_MINUTES + 5) * 60_000 - 10 * 60_000);
  // Nudge back 10 minutes so it's still provably before the 09:30 ET open while past the 45-min delay threshold.
  const delayed = classifyReportTiming({
    now: stillPreMarketButLate,
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 5,
    isManualRun: false,
  });
  assert(
    delayed.status === "delayed" || delayed.status === "intraday",
    `a run more than ${DELAYED_THRESHOLD_MINUTES}min late is never silently presented as an on-time pre-market report (got ${delayed.status})`
  );

  // Directly exercises the "delayed" branch in isolation: a hypothetical
  // early schedule (10:00 Israel) so the delay still lands hours before the
  // US market opens, rather than crossing into "intraday" first. 20 minutes
  // sits deliberately between DELAYED_THRESHOLD_MINUTES (12) and
  // MAX_LATENESS_MINUTES (30) — late enough to be labeled, not late enough
  // to be refused.
  const isolatedDelay = classifyReportTiming({
    now: new Date("2026-08-28T07:20:00Z"), // 10:20 IDT
    scheduledHourIsrael: 10,
    scheduledMinuteIsrael: 0,
    isManualRun: false,
  });
  assert(
    isolatedDelay.status === "delayed" && isolatedDelay.delayMinutes === 20,
    `a run more than ${DELAYED_THRESHOLD_MINUTES}min late but still genuinely pre-market is labeled "delayed" specifically (got status=${isolatedDelay.status} delay=${isolatedDelay.delayMinutes})`
  );

  // Note on reachability: with the production target of 15:58 Israel and a
  // 30-minute lateness cap, the latest permitted start is 16:28 Israel =
  // 09:28 New York — two minutes before the US open. So on the real schedule
  // this branch can no longer trigger; a run late enough to cross the open is
  // now refused outright instead of being relabeled. The branch is kept
  // because it is still correct for any later target, and is exercised here
  // with one: a 16:20 Israel target, 15 minutes late, lands at 09:35 ET.
  const intraday = classifyReportTiming({
    now: new Date("2026-08-28T13:35:00Z"), // 16:35 Israel = 09:35 New York
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 20,
    isManualRun: false,
  });
  assert(
    intraday.status === "intraday" && intraday.reportLabel === "Intraday Market Report",
    `a run starting after the US market opens is relabeled as an Intraday Market Report, never presented as pre-market (got status=${intraday.status} label=${intraday.reportLabel})`
  );

  // This is the exact 2026-08-28 failure mode: a run starting at 02:04 IDT
  // (hours after the US close) must NEVER be silently sent as a pre-market
  // report.
  const skipped = classifyReportTiming({
    now: afterHoursNy,
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 5,
    isManualRun: false,
  });
  assert(
    skipped.status === "skip",
    `a run starting hours after the US market closed (the 2026-08-28 02:04 IDT failure mode) is skipped, never sent as "pre-market" (got ${skipped.status})`
  );

  const manualBypass = classifyReportTiming({
    now: afterHoursNy,
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 5,
    isManualRun: true,
  });
  assert(manualBypass.status === "onTime", "a manual workflow_dispatch run bypasses the staleness guard entirely");
}

// ===== Israel DST correctness: the same 16:05 Israel-time target must
// resolve consistently whether "now" falls in Israel Daylight Time (summer,
// UTC+3) or Israel Standard Time (winter, UTC+2). =====
{
  // 2026-08-28 13:20 UTC = 16:20 IDT (summer, UTC+3) – 15 min after target.
  const summerOnTime = classifyReportTiming({
    now: new Date("2026-08-28T13:20:00Z"),
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 5,
    isManualRun: false,
  });
  assert(
    summerOnTime.delayMinutes === 15 && summerOnTime.actualIsraelDisplay === "16:20",
    `summer (IDT, UTC+3): 13:20 UTC correctly resolves to 16:20 Israel time, 15min delay (got delay=${summerOnTime.delayMinutes} display=${summerOnTime.actualIsraelDisplay})`
  );

  // 2026-01-28 14:20 UTC = 16:20 IST (winter, UTC+2) – also 15 min after the
  // same nominal 16:05 target, via a completely different UTC offset.
  const winterOnTime = classifyReportTiming({
    now: new Date("2026-01-28T14:20:00Z"),
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 5,
    isManualRun: false,
  });
  assert(
    winterOnTime.delayMinutes === 15 && winterOnTime.actualIsraelDisplay === "16:20",
    `winter (IST, UTC+2): 14:20 UTC correctly resolves to 16:20 Israel time, 15min delay (got delay=${winterOnTime.delayMinutes} display=${winterOnTime.actualIsraelDisplay})`
  );
}

// ===== Historical macro values never appear under "This Week To Watch" –
// only genuinely forward-looking earnings do. Already-published macro gets
// its own, honestly-labeled "Recent Macro Data" section instead. =====
{
  const econReading: EconomicReading = {
    key: "cpi",
    label: "CPI (מדד המחירים לצרכן, ארה\"ב)",
    value: 3.1,
    unit: "%",
    asOfDate: "2026-07-01",
    source: { source: "live" },
  };
  const futureEarning = {
    ticker: "ZZZZ",
    name: "Future Reporter Co",
    reportDate: "2099-01-01",
    daysRemaining: 5,
    urgency: "week" as const,
    reasonsHebrew: [],
    priority: "watchlist" as const,
  };

  const withMacroOnly: ReportData = makeReportData({
    weekAhead: {
      earnings: [],
      earningsStatus: "noneFound",
      economicReadings: [econReading],
      economicUnavailableCount: 0,
      unavailableNoticeHebrew: "",
    },
  });
  const mdMacroOnly = generateReport(withMacroOnly);
  const htmlMacroOnly = generateHtmlReport(withMacroOnly);
  assert(
    !mdMacroOnly.includes("This Week To Watch") && !htmlMacroOnly.includes("This Week To Watch"),
    "with no forward-looking earnings, 'This Week To Watch' is hidden entirely rather than showing historical macro data under it"
  );
  assert(
    mdMacroOnly.includes("Recent Macro Data (Already Published)") && htmlMacroOnly.includes("Recent Macro Data (Already Published)"),
    "already-published macro data is shown under its own honestly-labeled section, not 'This Week To Watch'"
  );

  const withFutureEarning: ReportData = makeReportData({
    earningsCalendar: [],
    weekAhead: {
      earnings: [futureEarning],
      earningsStatus: "confirmed",
      economicReadings: [econReading],
      economicUnavailableCount: 0,
      unavailableNoticeHebrew: "",
    },
  });
  const mdWithEarning = generateReport(withFutureEarning);
  assert(mdWithEarning.includes("This Week To Watch"), "a genuinely future earnings entry does surface under 'This Week To Watch'");
  const thisWeekIdx = mdWithEarning.indexOf("This Week To Watch");
  const recentMacroIdx = mdWithEarning.indexOf("Recent Macro Data (Already Published)");
  const nextSectionIdx = mdWithEarning.indexOf("## ", thisWeekIdx + 1);
  assert(
    recentMacroIdx > thisWeekIdx && (nextSectionIdx === -1 || recentMacroIdx >= nextSectionIdx),
    "the historical CPI reading is not nested inside the 'This Week To Watch' section body – it lives in its own section afterward"
  );
  assert(
    !mdWithEarning.slice(thisWeekIdx, nextSectionIdx === -1 ? undefined : nextSectionIdx).includes(econReading.label),
    "the 'This Week To Watch' section body itself contains no already-published macro reading"
  );
}

// ===== Alpha Vantage rate-limit recovery: cacheFirst() must fall back to a
// stale cached value on a RateLimitError (when one exists), and to
// "unavailable" (never a crash, never a fabricated value) when it doesn't.
// cacheFirst is async, so this (and everything after it) runs inside an
// async IIFE – kept last so every synchronous check above has already run
// and set process.exitCode before we get here. =====
async function runAsyncOnlyChecks(): Promise<void> {
  // ===== Earnings tracker persistence: loadTracker/saveTracker round-trip
  // via a real temp file on disk (never the real data/earnings-tracker.json). =====
  {
    const filePath = path.join(process.cwd(), "data", "selftest_earnings_tracker_loadsave.json");
    try {
      fs.rmSync(filePath, { force: true });
      assert(loadTracker(filePath).length === 0, "loadTracker returns an empty array when the file doesn't exist yet, never a crash");

      const sample: EarningsTrackingRecord[] = [
        {
          ticker: "ABC", name: "ABC Corp", earningsDate: "2026-09-01", expectedTiming: "unknown",
          firstSeenAt: "2026-08-20T00:00:00.000Z", lastSeenAt: "2026-08-20T00:00:00.000Z", status: "awaiting",
        },
      ];
      saveTracker(sample, filePath);
      const reloaded = loadTracker(filePath);
      assert(reloaded.length === 1 && reloaded[0].ticker === "ABC", "saveTracker + a fresh loadTracker round-trips the exact same record");

      fs.writeFileSync(filePath, "{ this is not valid JSON", "utf8");
      assert(loadTracker(filePath).length === 0, "a corrupt store file returns an empty array rather than crashing the run");
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  }

  // ===== Full multi-run lifecycle, exactly as it happens in production:
  // each call to runEarningsTracker independently loads from disk and saves
  // back to disk, so calling it repeatedly against the SAME file path is
  // functionally identical to separate process runs from persistence's
  // point of view (no in-memory state survives between the calls other than
  // through the file itself). Finnhub/Yahoo are stubbed via the injectable
  // fetchers – no network access. =====
  {
    const filePath = path.join(process.cwd(), "data", "selftest_earnings_tracker_lifecycle.json");
    try {
      fs.rmSync(filePath, { force: true });

      const panwEntry: EarningsCalendarEntry = {
        ticker: "PANW", name: "Palo Alto Networks, Inc.", reportDate: "2026-08-26", daysRemaining: 2,
        urgency: "week", estimatedEps: 0.51, timeOfDay: "post-market", reasonsHebrew: [], priority: "watchlist",
      };
      const nothingYet: ResultsFetcher = async () => ({ value: null, source: { source: "unavailable" } });
      const noClosesNeeded: ClosesFetcher = async () => ({ value: null, source: { source: "unavailable" } });

      // ----- RUN 1: PANW appears in Upcoming Earnings -> persisted as awaiting -----
      const run1 = await runEarningsTracker({
        filePath, now: new Date("2026-08-24T13:00:00.000Z"), upcomingEntries: [panwEntry],
        fetchResults: nothingYet, fetchCloses: noClosesNeeded,
      });
      assert(run1.coverage.tracked === 1 && run1.coverage.awaiting === 1, "RUN 1: PANW is persisted as a new 'awaiting' record");
      assert(run1.entries.length === 0, "RUN 1: nothing shown in Earnings Follow-up yet (not due)");

      // ----- RUN 2: fresh load from disk -> PANW is still remembered -----
      const run2 = await runEarningsTracker({
        filePath, now: new Date("2026-08-25T13:00:00.000Z"), upcomingEntries: [panwEntry],
        fetchResults: nothingYet, fetchCloses: noClosesNeeded,
      });
      assert(run2.coverage.tracked === 1, "RUN 2: fresh load from disk still shows exactly one tracked PANW record (no duplicate)");
      assert(
        loadTracker(filePath)[0].firstSeenAt === run1.records[0].firstSeenAt,
        "RUN 2: firstSeenAt from RUN 1 is preserved across the fresh disk load"
      );

      // ----- RUN 3: earnings result becomes available -----
      const resultAvailable: ResultsFetcher = async (ticker) => ({
        value: [{
          symbol: ticker, date: "2026-08-26", timeOfDay: "post-market",
          epsActual: 1.08, epsEstimate: 1.01, revenueActual: 46_700_000_000, revenueEstimate: 45_900_000_000,
        }],
        source: { source: "live" },
      });
      // Closes as they ACTUALLY exist to a pre-market run on 2026-08-27: the
      // 27th's own session has not happened yet, so its close cannot be here.
      // PANW reported after the close on the 26th, so the reaction needs the
      // 27th's close and is genuinely not computable during this run.
      const closesThroughWednesday: ClosesFetcher = async () => ({
        value: [
          { date: "2026-08-25", close: 200 },
          { date: "2026-08-26", close: 202 },
        ],
        source: { source: "live" },
      });
      // The scheduled report runs at 16:00 Israel = 09:00 New York, i.e.
      // BEFORE the US open – that is the real timing every production run has.
      const run3 = await runEarningsTracker({
        filePath, now: new Date("2026-08-27T13:00:00.000Z"), upcomingEntries: [panwEntry],
        fetchResults: resultAvailable, fetchCloses: closesThroughWednesday,
      });
      const panwAfterRun3 = run3.records.find((r) => r.ticker === "PANW");
      assert(
        panwAfterRun3?.status === "reportedAwaitingReaction",
        `RUN 3: with the actuals known but the required next-session close not yet existing, PANW is 'reportedAwaitingReaction' – never prematurely 'reported' (got ${panwAfterRun3?.status})`
      );
      assert(
        panwAfterRun3?.result?.actualEps === 1.08 && panwAfterRun3?.result?.epsSurprisePct !== null,
        "RUN 3: actual EPS and a computed surprise% are stored immediately, without waiting for the reaction"
      );
      assert(
        panwAfterRun3?.result?.reaction == null,
        "RUN 3: the stock reaction stays null rather than being computed against a session that hasn't closed"
      );
      assert(
        run3.coverage.resultsFound === 1 && run3.coverage.reactionsCalculated === 0,
        "RUN 3: coverage reflects one result found and no reaction calculated yet"
      );

      // ----- RUN 3b: the next pre-market run, once the 27th has closed -----
      const closesThroughThursday: ClosesFetcher = async () => ({
        value: [
          { date: "2026-08-25", close: 200 },
          { date: "2026-08-26", close: 202 },
          { date: "2026-08-27", close: 192.7 }, // next session close after the after-market report
        ],
        source: { source: "live" },
      });
      const run3b = await runEarningsTracker({
        filePath, now: new Date("2026-08-28T13:00:00.000Z"), upcomingEntries: [panwEntry],
        fetchResults: resultAvailable, fetchCloses: closesThroughThursday,
      });
      const panwAfterRun3b = run3b.records.find((r) => r.ticker === "PANW");
      assert(
        panwAfterRun3b?.status === "reported",
        `RUN 3b: PANW completes to 'reported' on the next run, once the required session close genuinely exists (got ${panwAfterRun3b?.status})`
      );
      assert(
        panwAfterRun3b?.result?.reaction != null,
        "RUN 3b: the stock reaction is calculated once sufficient market data exists"
      );
      assert(
        run3b.coverage.resultsFound === 1 && run3b.coverage.reactionsCalculated === 1,
        "RUN 3b: coverage reflects one result found with a calculated reaction"
      );

      // ----- RUN 4: fresh process again -----
      const failIfCalled = async (): Promise<never> => {
        throw new Error("should not be called for an already-reported record");
      };
      const run4 = await runEarningsTracker({
        filePath, now: new Date("2026-08-31T13:00:00.000Z"), upcomingEntries: [panwEntry], // Nasdaq might still list it briefly
        fetchResults: failIfCalled, fetchCloses: failIfCalled,
      });
      assert(run4.coverage.tracked === 1, "RUN 4: PANW is not re-added as a duplicate upcoming event – still exactly one tracked record");
      const panwAfterRun4 = run4.records.find((r) => r.ticker === "PANW");
      assert(panwAfterRun4?.status === "reported", "RUN 4: the reported result remains available after a fresh load – status was not reset to 'awaiting'");
      assert(
        run4.entries.some((e) => e.ticker === "PANW" && e.result.actualEps === 1.08),
        "RUN 4: PANW's real reported EPS is still shown in Earnings Follow-up after a fresh load"
      );
      assert(
        filterOutReported([panwEntry], run4.records).length === 0,
        "RUN 4: PANW is correctly excluded from Upcoming Earnings Calendar now that it has reported"
      );
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  }

  // ===== Section 4: a result is never marked complete before the required
  // regular-session closing price exists – "reported / awaiting market
  // reaction" as its own intermediate, re-checked state. =====
  {
    const filePath = path.join(process.cwd(), "data", "selftest_earnings_tracker_awaiting_reaction.json");
    try {
      fs.rmSync(filePath, { force: true });
      const tuesdayEntry: EarningsCalendarEntry = {
        ticker: "TESTCO", name: "Test Co", reportDate: "2026-08-25", daysRemaining: 1,
        urgency: "tomorrow", timeOfDay: "post-market", reasonsHebrew: [], priority: "watchlist",
      };
      const resultAvailable: ResultsFetcher = async (ticker) => ({
        value: [{ symbol: ticker, date: "2026-08-25", timeOfDay: "post-market", epsActual: 2.0, epsEstimate: 1.9 }],
        source: { source: "live" },
      });
      // Tuesday evening: Wednesday's regular-session close doesn't exist yet.
      const closesWithoutNextSession: ClosesFetcher = async () => ({
        value: [{ date: "2026-08-24", close: 100 }, { date: "2026-08-25", close: 102 }],
        source: { source: "live" },
      });
      const evening = await runEarningsTracker({
        filePath, now: new Date("2026-08-25T23:00:00.000Z"), upcomingEntries: [tuesdayEntry],
        fetchResults: resultAvailable, fetchCloses: closesWithoutNextSession,
      });
      const recEvening = evening.records.find((r) => r.ticker === "TESTCO");
      assert(
        recEvening?.status === "reportedAwaitingReaction",
        `actual EPS known but the next session hasn't closed -> 'reportedAwaitingReaction', never a premature 'reported' (got ${recEvening?.status})`
      );
      assert(
        recEvening?.result?.actualEps === 2.0 && recEvening?.result?.reaction == null,
        "the real EPS is stored immediately; the reaction stays null rather than being estimated or guessed"
      );
      assert(
        evening.entries.some((e) => e.ticker === "TESTCO" && e.result.reaction == null),
        "Earnings Follow-up already shows the real EPS while explicitly marking the reaction as not yet available"
      );

      // Thursday pre-market: Wednesday's regular-session close now genuinely
      // exists and is final. Note this is the THURSDAY run, not Wednesday's –
      // a report generated at 16:00 Israel runs at 09:00 New York, before the
      // US open, so Wednesday's own close is not available to Wednesday's run.
      const closesWithNextSession: ClosesFetcher = async () => ({
        value: [
          { date: "2026-08-24", close: 100 },
          { date: "2026-08-25", close: 102 },
          { date: "2026-08-26", close: 99 },
        ],
        source: { source: "live" },
      });
      const failIfResultsRefetched = async (): Promise<never> => {
        throw new Error("actual figures should not be re-fetched once already known");
      };
      const nextDay = await runEarningsTracker({
        filePath, now: new Date("2026-08-27T13:00:00.000Z"), upcomingEntries: [tuesdayEntry],
        fetchResults: failIfResultsRefetched, fetchCloses: closesWithNextSession,
      });
      const recNextDay = nextDay.records.find((r) => r.ticker === "TESTCO");
      assert(recNextDay?.status === "reported", `once the next session closes, the record completes to 'reported' (got ${recNextDay?.status})`);
      assert(
        recNextDay?.result?.reaction?.reactionPercent !== undefined,
        "the reaction is now calculated, without ever re-fetching the actual EPS/revenue figures"
      );
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  }

  const probeKey = "selftest_ratelimit_probe";
  const probePath = path.join(process.cwd(), "cache", `${probeKey}.json`);
  const emptyProbePath = path.join(process.cwd(), "cache", `${probeKey}_empty.json`);
  try {
    fs.mkdirSync(path.join(process.cwd(), "cache"), { recursive: true });
    fs.writeFileSync(
      probePath,
      JSON.stringify({ savedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), data: { probe: "stale-but-usable" } }),
      "utf8"
    );
    fs.rmSync(emptyProbePath, { force: true });

    const rateLimitedFetcher = () => {
      throw new RateLimitError("Alpha Vantage quota hit (selftest)");
    };

    const withStaleCache = await cacheFirst(probeKey, 1, rateLimitedFetcher, () => {});
    assert(
      withStaleCache.source.source === "cached" && (withStaleCache.value as any)?.probe === "stale-but-usable",
      "on a RateLimitError, cacheFirst recovers by falling back to the stale cached value rather than failing the run"
    );

    const withoutCache = await cacheFirst(`${probeKey}_empty`, 1, rateLimitedFetcher, () => {});
    assert(
      withoutCache.value === null && withoutCache.source.source === "unavailable",
      "on a RateLimitError with no cache at all, cacheFirst returns an honest 'unavailable' rather than crashing or fabricating a value"
    );
  } finally {
    fs.rmSync(probePath, { force: true });
    fs.rmSync(emptyProbePath, { force: true });
  }

  // ===== Report Health: scheduled time, actual start time, and email-sent
  // time are all logged (2026-08-28's root failure was invisible precisely
  // because nothing surfaced these three timestamps together). =====
  const timing = classifyReportTiming({
    now: new Date("2026-08-28T13:20:00Z"),
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 5,
    isManualRun: false,
  });
  const goodCandidateForHealth = makeStock({ ticker: "HEALTH", price: 100, finalScore: 8, dataQuality: makeDQ() });
  const healthReportData: ReportData = makeReportData({
    topOpportunities: [goodCandidateForHealth],
    watchlist: [goodCandidateForHealth],
    reportQuality: GOOD_QUALITY,
  });

  const beforeSend = buildReportHealth({ data: healthReportData, timing, emailSentAtIso: null });
  assert(beforeSend.emailSentIsrael === null, "before sending, Report Health honestly shows no email-sent timestamp yet");
  assert(beforeSend.scheduledIsrael === "16:05" && beforeSend.actualStartIsrael === "16:20", "Report Health logs both the scheduled and actual start times");

  const afterSend = buildReportHealth({ data: healthReportData, timing, emailSentAtIso: "2026-08-28T13:25:00.000Z" });
  assert(afterSend.emailSentIsrael !== null && afterSend.emailSentIsrael.includes("16:25"), "after sending, Report Health logs the actual email-sent timestamp");

  const lines = formatReportHealth(afterSend);
  assert(
    lines.some((l) => l.includes("Scheduled time")) &&
      lines.some((l) => l.includes("Actual start")) &&
      lines.some((l) => l.includes("Email sent")) &&
      lines.some((l) => l.includes("Delay")) &&
      lines.some((l) => l.includes("Top Opportunities")) &&
      lines.some((l) => l.includes("Provider failures")),
    "formatReportHealth prints scheduled/actual/email timestamps, delay, Top Opportunities counts, and provider failure counts"
  );

  // ===== Section 5: Finnhub calls are throttled under its 60/min free tier.
  // Company fundamentals moved off Alpha Vantage onto Finnhub, so a
  // cold-cache run now makes ~3 Finnhub calls per stock with no daily budget
  // guard in front of them. =====
  {
    const order: number[] = [];
    const started: number[] = [];
    const call = (id: number) =>
      throttleFinnhub(async () => {
        started.push(Date.now());
        order.push(id);
        return id;
      });

    const t0 = Date.now();
    await Promise.all([call(1), call(2), call(3)]);
    const elapsed = Date.now() - t0;

    assert(
      order.join(",") === "1,2,3",
      `throttled Finnhub calls run strictly in submission order, never all at once (got ${order.join(",")})`
    );
    assert(
      started.length === 3 && started[1] - started[0] >= 500 && started[2] - started[1] >= 500,
      "consecutive Finnhub calls are spaced apart rather than fired in one burst"
    );
    assert(elapsed >= 1000, `three throttled calls take real time to drain (got ${elapsed}ms)`);

    // A failed request still consumed quota, and must not wedge the queue.
    let afterFailure = false;
    await throttleFinnhub(async () => {
      throw new Error("simulated Finnhub 429");
    }).catch(() => undefined);
    await throttleFinnhub(async () => {
      afterFailure = true;
    });
    assert(afterFailure, "a rejected Finnhub call does not deadlock the throttle – later calls still run");
  }
}

// ===== Section 4: US market calendar — full closures and early closes =====
{
  // Checked against the real published NYSE calendars for these years. The
  // rules are derived, not hardcoded, so these assertions are what proves the
  // derivation is right in years nobody has hand-entered.
  const holidays2026 = usMarketHolidays(2026).map((h) => h.date);
  const expected2026 = [
    "2026-01-01", // New Year's Day (Thu)
    "2026-01-19", // MLK — 3rd Monday
    "2026-02-16", // Washington's Birthday — 3rd Monday
    "2026-04-03", // Good Friday (Easter 2026-04-05)
    "2026-05-25", // Memorial Day — last Monday
    "2026-06-19", // Juneteenth (Fri)
    "2026-07-03", // Independence Day: Jul 4 is a Saturday -> observed Friday
    "2026-09-07", // Labor Day — 1st Monday
    "2026-11-26", // Thanksgiving — 4th Thursday
    "2026-12-25", // Christmas (Fri)
  ];
  assert(
    holidays2026.join(",") === expected2026.join(","),
    `the 2026 NYSE holiday calendar is derived correctly (got ${holidays2026.join(",")})`
  );

  // Weekend-observation rules, in both directions.
  assert(usMarketHolidayName("2026-07-03") === "Independence Day", "a Saturday holiday is observed on the preceding Friday");
  assert(usMarketHolidayName("2027-07-05") === "Independence Day", "a Sunday holiday is observed on the following Monday");
  // New Year's Day is the documented exception: a Saturday Jan 1 does NOT
  // close the market on the preceding Friday, which is in the previous year.
  assert(!isUsMarketHoliday("2027-12-31"), "a Saturday New Year's Day does not close the market on the preceding Friday");

  // Good Friday moves with Easter and must track it.
  assert(isUsMarketHoliday("2025-04-18") && isUsMarketHoliday("2026-04-03") && isUsMarketHoliday("2027-03-26"),
    "Good Friday is derived from Easter and is correct across years");

  // This is the day the pipeline actually mailed a report for a market that
  // never opened.
  assert(isUsMarketHoliday("2026-09-07"), "2026-09-07 (Labor Day) is recognised as a full US market closure");
  assert(!isUsTradingDay("2026-09-07"), "Labor Day is not a trading day");
  assert(isUsTradingDay("2026-09-08"), "the day after a holiday is a normal trading day again");
  assert(!isUsTradingDay("2026-09-05"), "a Saturday is not a trading day");

  // Early closes are half-days, NOT closures.
  assert(isUsEarlyCloseDay("2026-11-27"), "the Friday after Thanksgiving is an early-close day");
  assert(isUsEarlyCloseDay("2026-12-24"), "Christmas Eve on a weekday is an early-close day");
  assert(isUsTradingDay("2026-11-27"), "an early-close day is still a trading day – the market opens normally");
  assert(usMarketCloseMinute("2026-11-27") === 13 * 60, "an early-close day closes at 13:00 ET");
  assert(usMarketCloseMinute("2026-11-25") === 16 * 60, "a normal trading day closes at 16:00 ET");
  // When Jul 4 falls on a Saturday, Jul 3 IS the holiday, so there is no
  // early close that year — an early close and a closure cannot coexist.
  assert(!isUsEarlyCloseDay("2026-07-03"), "when Jul 3 is itself the observed holiday it is not also an early-close day");
  assert(isUsEarlyCloseDay("2025-07-03"), "Jul 3 is an early close when Jul 4 is a normal weekday");
}

// ===== Section 4: the report is not sent on a US market holiday =====
{
  // 13:00 UTC on Labor Day = 09:00 New York = normally a perfect pre-market
  // slot. The only thing making this wrong is that the market never opens.
  const onHoliday = classifyReportTiming({
    now: new Date("2026-09-07T13:00:00Z"),
    scheduledHourIsrael: 15,
    scheduledMinuteIsrael: 58,
    isManualRun: false,
    workflowStartedAt: new Date("2026-09-07T13:00:00Z"),
  });
  assert(onHoliday.usMarketStateAtRun === "holiday", "a US market holiday is detected as its own market state, not as 'pre-market'");
  assert(onHoliday.status === "skip", "no report is sent on a full US market holiday");
  assert(onHoliday.reportLabel === "Report Skipped (US Market Holiday)", "the holiday skip is labelled distinctly from the stale/late skips");
  assert(onHoliday.reasonHebrew.includes("Labor Day"), "the skip reason names the actual holiday");

  // An early close must NOT suppress the pre-market report.
  const onEarlyClose = classifyReportTiming({
    now: new Date("2026-11-27T14:00:00Z"), // 09:00 New York on the Friday after Thanksgiving
    scheduledHourIsrael: 15,
    scheduledMinuteIsrael: 58,
    isManualRun: false,
    workflowStartedAt: new Date("2026-11-27T14:00:00Z"),
  });
  assert(onEarlyClose.usMarketStateAtRun === "pre-market", "an early-close day is still pre-market before the open – the report is valid");
  assert(onEarlyClose.status !== "skip", "the pre-market report IS sent on an early-close day");

  // ...but the shortened session must be reflected once it ends: 14:00 ET is
  // open on a normal day and already closed on a half-day.
  assert(usMarketState(new Date("2026-11-27T19:00:00Z")) === "after-hours", "at 14:00 ET an early-close day is correctly already after-hours");
  assert(usMarketState(new Date("2026-11-25T19:00:00Z")) === "open", "at 14:00 ET a normal trading day is still open");

  // A manual dispatch remains an explicit operator request and still bypasses.
  const manualOnHoliday = classifyReportTiming({
    now: new Date("2026-09-07T13:00:00Z"),
    scheduledHourIsrael: 15,
    scheduledMinuteIsrael: 58,
    isManualRun: true,
  });
  assert(manualOnHoliday.status !== "skip", "a manual workflow_dispatch run still produces a report on a holiday – the operator asked for it deliberately");
}

// ===== Section 1/2: did the cron fire when we asked it to? =====
//
// The workflow now carries explicit UTC crons ('58 12' for IDT, '58 13' for
// IST), both representing 15:58 Israel. This measures how far off the real
// start was, and separates "GitHub was late" from "the off-season cron fired".
{
  // Dead on target in summer: 12:58 UTC = 15:58 IDT.
  const onTarget = diagnoseSchedule({
    workflowStartedAt: new Date("2026-09-10T12:58:00Z"),
    targetHourIsrael: 15,
    targetMinuteIsrael: 58,
  });
  assert(onTarget.verdict === "onTarget", `an on-time start is reported as onTarget (got ${onTarget.verdict})`);
  assert(onTarget.delayMinutes === 0, `an on-time start has zero delay (got ${onTarget.delayMinutes})`);
  assert(onTarget.startedIsraelDisplay === "15:58", "the Israel-time display resolves IDT correctly");

  // The same nominal target in winter, via the other cron and a different UTC
  // offset: 13:58 UTC = 15:58 IST. Must be equally on target.
  const onTargetWinter = diagnoseSchedule({
    workflowStartedAt: new Date("2026-01-14T13:58:00Z"),
    targetHourIsrael: 15,
    targetMinuteIsrael: 58,
  });
  assert(
    onTargetWinter.verdict === "onTarget" && onTargetWinter.startedIsraelDisplay === "15:58",
    `the IST cron hits the same Israel wall-clock target (got ${onTargetWinter.verdict} at ${onTargetWinter.startedIsraelDisplay})`
  );

  // The real run 35002540222 signature: created 17:38:36Z = 20:38 Israel.
  const realLateRun = diagnoseSchedule({
    workflowStartedAt: new Date("2026-09-15T17:38:36Z"),
    targetHourIsrael: 15,
    targetMinuteIsrael: 58,
  });
  assert(realLateRun.verdict === "late", `the real 20:38 start is reported as late (got ${realLateRun.verdict})`);
  assert(realLateRun.delayMinutes === 280, `the real run was 280 minutes past target (got ${realLateRun.delayMinutes})`);
  assert(
    !realLateRun.looksLikeDstDrift,
    "a 280-minute delay is scheduler lag, not the one-hour DST signature"
  );

  // Exactly one hour late during a changeover month: the off-season cron, not
  // ordinary lag — the distinction the summary needs to name the right cause.
  const dstLate = diagnoseSchedule({
    // 2026-03-10 is before Israel's late-March DST switch, so this is IST:
    // 13:58 UTC = 15:58 Israel, exactly 60 min past a 14:58 target.
    workflowStartedAt: new Date("2026-03-10T13:58:00Z"),
    targetHourIsrael: 14,
    targetMinuteIsrael: 58,
  });
  assert(
    dstLate.delayMinutes === 60 && dstLate.looksLikeDstDrift,
    `an exactly-60-minute offset is flagged as DST drift (got delay=${dstLate.delayMinutes} drift=${dstLate.looksLikeDstDrift})`
  );

  // An hour EARLY is the other half of the same signature.
  const dstEarly = diagnoseSchedule({
    workflowStartedAt: new Date("2026-10-28T11:58:00Z"), // 13:58 IST, target 14:58
    targetHourIsrael: 14,
    targetMinuteIsrael: 58,
  });
  assert(
    dstEarly.delayMinutes === -60 && dstEarly.looksLikeDstDrift && dstEarly.verdict === "early",
    `an hour-early start is reported as early DST drift (got delay=${dstEarly.delayMinutes} verdict=${dstEarly.verdict})`
  );

  // Day-wrap: a start after local midnight is very late, never "early".
  const postMidnight = diagnoseSchedule({
    workflowStartedAt: new Date("2026-08-28T23:04:00Z"), // 02:04 Israel next day
    targetHourIsrael: 15,
    targetMinuteIsrael: 58,
  });
  assert(
    postMidnight.verdict === "late" && postMidnight.delayMinutes > 600,
    `a post-midnight start is reported as very late (got ${postMidnight.verdict} delay=${postMidnight.delayMinutes})`
  );
}

// ===== Section 2/13: a run GitHub started hours late is not mailed at all,
// even if the US market technically happens to still be open =====
{
  // 2026-09-09T19:30Z = 22:30 Israel = 15:30 New York – market still OPEN,
  // so the market-state branch alone would have sent this as an "Intraday"
  // report ~6.5 hours after the 16:00 target.
  const veryLate = classifyReportTiming({
    now: new Date("2026-09-09T19:30:00Z"),
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 0,
    isManualRun: false,
    workflowStartedAt: new Date("2026-09-09T19:30:00Z"),
  });
  assert(veryLate.usMarketStateAtRun === "open", "sanity: the US market really is still open at 22:30 Israel");
  assert(veryLate.status === "skip", `a run ${veryLate.delayMinutes}min past the target is skipped, not mailed hours late`);
  assert(veryLate.reportLabel === "Report Skipped (Too Late)", "the too-late skip is labeled distinctly from the after-hours stale skip");

  // Just inside the 30-minute cap, still pre-market: must NOT be skipped.
  // 13:20Z = 16:20 Israel = 20 minutes after the 16:00 target.
  const tolerable = classifyReportTiming({
    now: new Date("2026-09-09T13:20:00Z"),
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 0,
    isManualRun: false,
    workflowStartedAt: new Date("2026-09-09T13:20:00Z"),
  });
  assert(tolerable.status !== "skip", "a moderately late but still pre-market run is delivered, not skipped – the cap must not swallow normal delays");

  // The exact shape of run 35002540222: GitHub created the job at 17:38:36Z =
  // 20:38 Israel, 280 minutes after the 15:58 target. The US market was still
  // open (13:38 New York), which is precisely why the deployed code relabeled
  // it "Intraday Market Report" and mailed it at 20:41 as if it were the
  // 16:00 report. The lateness cap must now win over the market-state branch.
  const run35002540222 = classifyReportTiming({
    now: new Date("2026-09-15T17:41:52Z"),
    scheduledHourIsrael: 15,
    scheduledMinuteIsrael: 58,
    isManualRun: false,
    workflowStartedAt: new Date("2026-09-15T17:38:36Z"),
  });
  assert(
    run35002540222.usMarketStateAtRun === "open",
    "sanity: the US market really was still open during run 35002540222"
  );
  assert(
    run35002540222.status === "skip" && run35002540222.reportLabel === "Report Skipped (Too Late)",
    `the real 20:38-Israel run is refused, not mailed as an Intraday report (got status=${run35002540222.status} label=${run35002540222.reportLabel} delay=${run35002540222.delayMinutes})`
  );
  assert(
    run35002540222.delayMinutes === 280,
    `the reported lateness is measured from the job start, not the send (got ${run35002540222.delayMinutes})`
  );

  // The off-season cron during a DST changeover month fires ~60 min early.
  // It must be discarded, not delivered as an hour-early duplicate.
  const offSeasonCron = classifyReportTiming({
    now: new Date("2026-10-28T11:58:00Z"), // 13:58 Israel (IST) — 120 min early
    scheduledHourIsrael: 15,
    scheduledMinuteIsrael: 58,
    isManualRun: false,
    workflowStartedAt: new Date("2026-10-28T11:58:00Z"),
  });
  assert(
    offSeasonCron.status === "skip" && offSeasonCron.reportLabel === "Report Skipped (Too Early)",
    `a run that starts well before the target is refused as too early (got status=${offSeasonCron.status} label=${offSeasonCron.reportLabel} delay=${offSeasonCron.delayMinutes})`
  );

  // A run GitHub starts after local midnight is ~10 hours LATE, not ~14 hours
  // early. Without the day-wrap correction the signed delay would read as a
  // large negative number and be reported as the wrong failure entirely.
  const afterMidnight = classifyReportTiming({
    now: new Date("2026-09-09T23:04:00Z"), // 02:04 Israel the next day
    scheduledHourIsrael: 15,
    scheduledMinuteIsrael: 58,
    isManualRun: false,
    workflowStartedAt: new Date("2026-09-09T23:04:00Z"),
  });
  assert(
    afterMidnight.delayMinutes > 0 && afterMidnight.reportLabel === "Report Skipped (Too Late)",
    `a post-midnight start is classified as very late, not as early (got delay=${afterMidnight.delayMinutes} label=${afterMidnight.reportLabel})`
  );

  // Schedule delay is a property of when GitHub started us, NOT of how long
  // generation took. Previously `now` was used for both, silently adding the
  // whole pipeline duration to every reported delay.
  const startedOnTime = classifyReportTiming({
    now: new Date("2026-09-09T13:04:00Z"),        // send time: 16:04 Israel
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 0,
    isManualRun: false,
    workflowStartedAt: new Date("2026-09-09T13:00:00Z"), // job start: 16:00 Israel
  });
  assert(
    startedOnTime.delayMinutes === 0,
    `generation duration is not counted as schedule delay (got ${startedOnTime.delayMinutes}min)`
  );
}

// ===== Section 6: missing OPTIONAL enrichment reduces confidence, it never
// eliminates an otherwise valid, liquid candidate =====
{
  const liquidButUnenriched = makeStock({
    ticker: "LIQ",
    // Company identity and news both unavailable – the exact shape produced
    // when the fundamentals/news provider is rate-limited. Price, volume and
    // market cap (the CORE data) are all present and live.
    profile: { symbol: "LIQ", marketCap: 50_000_000_000 },
    profileSource: { source: "live" },
    news: [],
    newsSource: { source: "live" },
  });
  const dqUnenriched = computeDataQuality(liquidButUnenriched, "genuinelyMissing");
  assert(!dqUnenriched.excluded, "a liquid, well-priced candidate is not excluded just because profile/news/technicals are missing");
  assert(
    dqUnenriched.label === "High" || dqUnenriched.label === "Medium",
    `missing optional enrichment keeps the candidate recommendable (got label=${dqUnenriched.label}, coverage=${dqUnenriched.coverageScore})`
  );
  assert(dqUnenriched.confidenceScore < 100, "missing optional enrichment still costs confidence – it is never free");

  const fullyEnriched = computeDataQuality(makeStock({ ticker: "FULL" }), "available");
  assert(
    fullyEnriched.confidenceScore > dqUnenriched.confidenceScore,
    "a fully enriched candidate scores strictly higher confidence than an unenriched one"
  );

  // The whole point: it must actually survive into Top Opportunities.
  const withDq = { ...liquidButUnenriched, dataQuality: dqUnenriched };
  const built = buildTopOpportunities([withDq], 3);
  assert(
    built.topOpportunities.length === 1 && !built.emergencyModeActive,
    "an otherwise valid liquid candidate with no company name still becomes a NORMAL Top Opportunity, not an emergency-mode fallback"
  );

  // ...while CORE data missing still gates strictly.
  const noMarketCap = makeStock({
    ticker: "NOCAP",
    profile: { symbol: "NOCAP", name: "No Cap Inc" },
    volume: 0,
  });
  const dqNoCore = computeDataQuality(noMarketCap, "available");
  assert(dqNoCore.excluded, "core data (market cap + volume) genuinely missing still excludes the candidate – safety rules stay strict");
}

// ===== Section 6: "Top Opportunities: 0" always carries a counted reason ====
{
  const excludedStock = { ...makeStock({ ticker: "EX" }), dataQuality: makeDQ({ excluded: true, label: "Excluded" }) };
  const lowStock = { ...makeStock({ ticker: "LOW" }), dataQuality: makeDQ({ excluded: false, label: "Low" }) };
  const goodStock = { ...makeStock({ ticker: "OK" }), dataQuality: makeDQ({ excluded: false, label: "High" }) };
  const counts = summarizeRejections([excludedStock, lowStock, goodStock]);
  assert(counts.excludedByDataQuality === 1, "an excluded candidate is counted under excludedByDataQuality");
  assert(counts.belowQualityLabel === 1, "a Low-label candidate is counted under belowQualityLabel");
  assert(counts.rankedBelowCutoff === 1, "a qualifying candidate that simply ranked too low is counted separately, not as a data failure");
  assert(
    Object.values(counts).reduce((a, b) => a + b, 0) === 3,
    "every non-selected candidate lands in exactly one rejection bucket – the funnel always adds up"
  );
}

// ===== Section 12: Report Health records the full timing chain =====
{
  const timing = classifyReportTiming({
    now: new Date("2026-09-09T13:04:00Z"),
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 0,
    isManualRun: false,
    workflowStartedAt: new Date("2026-09-09T10:35:00Z"),
  });
  const health = buildReportHealth({
    data: makeReportData({
      generatedAt: "2026-09-09T13:03:00.000Z",
      scanned: 60,
      qualified: 17,
      opportunityFunnel: {
        candidatesEvaluated: 9,
        topOpportunities: 2,
        reducedConfidence: 0,
        rejectionCounts: { belowQualityLabel: 4, rankedBelowCutoff: 3 },
      },
    }),
    timing,
    emailSentAtIso: "2026-09-09T13:04:00.000Z",
    workflowStartedAtIso: "2026-09-09T10:35:00.000Z",
    generationStartedAtIso: "2026-09-09T13:00:00.000Z",
  });

  assert(health.workflowStartedIsrael !== null && health.workflowStartedIsrael.includes("13:35"),
    "Report Health records the instant GitHub actually started the job, separately from generation");
  assert(health.reportGeneratedIsrael !== null && health.reportGeneratedIsrael.includes("16:03"),
    "Report Health records when the report itself was generated");
  assert(health.totalRuntimeSeconds === 240,
    `Report Health records total runtime from generation start to email sent, excluding the delivery wait (got ${health.totalRuntimeSeconds})`);
  assert(health.candidatesEvaluated === 9 && health.scanned === 60 && health.qualified === 17,
    "Report Health carries the full Top Opportunities funnel, not just the final count");

  const lines = formatReportHealth(health);
  assert(lines.some((l) => l.includes("Workflow started")), "formatReportHealth prints the workflow start time");
  assert(lines.some((l) => l.includes("Report generated")), "formatReportHealth prints the report generation time");
  assert(lines.some((l) => l.includes("Total runtime")), "formatReportHealth prints total runtime");
  assert(lines.some((l) => l.includes("Funnel:")), "formatReportHealth prints the scanned/qualified/evaluated funnel");
  assert(lines.some((l) => l.includes("Rejection reasons")), "formatReportHealth prints why candidates were rejected");
}

// ===== Section 7: weak promotional / low-signal headlines are rejected,
// without over-matching genuinely material news =====
{
  const headline = (title: string): NewsItem => makeNews({ title });

  // Every one of these was observed leaking into a REAL generated report.
  const mustReject: Array<[string, string]> = [
    ["algorithmic move recap", "Amazon.com Inc Stock (AMZN) Moved Up by 3.69% on Aug 28: A Full Analysis"],
    ["13F 'makes new investment'", "Leeward Financial Partners LLC Makes New Investment in Amazon.com, Inc. $AMZN"],
    ["fund-manager trade disclosure", "Cathie Wood Buys $28.1 Million Worth of Meta Stock, Dumps Alphabet Shares"],
    ["shareholder D&O complaint", "AI NEWS—W.D. Wash.: Complaint alleges Microsoft D&Os misled about AI strategy"],
    ["13F 'takes position in'", "Private Advisory Group LLC Takes Position in Amazon.com, Inc. $AMZN"],
    ["13F 'increases holdings'", "Vanguard Group Inc. Increases Holdings in NVIDIA"],
    ["13F share sale by a bank", "Bank of Montreal Can Sells 1,200 Shares of Meta Platforms"],
    ["named-manager portfolio move", "Cathie Wood’s ARK sells Alphabet stock, buys Meta and Beam Therapeutics"],
    ["analyst-firm award PR", "Acme named a Leader in the 2026 Gartner Magic Quadrant"],
    ["partner award PR", "Acme Wins Partner of the Year Award from Microsoft"],
    ["corporate celebration PR", "Acme celebrates 25th anniversary with ribbon-cutting ceremony"],
    ["employer-branding PR", "Acme recognized as one of the Best Places to Work in 2026"],
  ];
  for (const [label, title] of mustReject) {
    assert(isPromotionalOrLegalNews(headline(title)), `${label} is rejected as weak/promotional news`);
  }

  // The other half of the requirement: the filter must not swallow real news.
  // "wins an award" is promotional; "wins a contract" and "wins approval" are
  // material, and they share the same verb.
  const mustKeep: Array<[string, string, string]> = [
    ["major contract", "contract", "Acme wins $2.4 billion Pentagon cloud contract"],
    ["regulatory approval", "regulation", "Acme wins FDA approval for its lead cancer therapy"],
    ["enforcement action", "regulation", "DOJ complaint alleges Acme violated antitrust law"],
    ["enforcement investigation", "regulation", "DOJ opens investigation into Acme"],
    ["M&A, all-cash phrasing", "ma", "Acme buys rival chipmaker for $8 billion"],
    ["earnings + guidance", "earnings", "Acme raises full-year guidance after record quarterly earnings"],
    ["management change", "management", "Acme CEO steps down; CFO named interim chief executive"],
    ["product launch", "productStrategic", "Acme launches new AI inference platform"],
    ["strategic partnership", "contract", "Acme Partners with Nvidia to build AI data centers"],
    ["corporate division named 'Capital'", "earnings", "Acme Capital Markets reports record quarterly results"],
    ["company's own divestiture + buyback", "productStrategic", "Acme sells its storage division, buys back $3 billion of stock"],
  ];
  for (const [label, expectedCategory, title] of mustKeep) {
    assert(!isPromotionalOrLegalNews(headline(title)), `${label} is NOT rejected – the promotional filter must not swallow real news`);
    const cat = materiality(headline(title)).category;
    assert(cat === expectedCategory, `${label} is classified as "${expectedCategory}" (got "${cat}")`);
  }

  // Materiality must follow the requested priority order.
  const w = (title: string) => materiality(headline(title)).weight;
  assert(
    w("Acme reports Q3 earnings, beats estimates") > w("Acme raises full-year outlook") &&
      w("Acme raises full-year outlook") > w("Acme to acquire Beta Corp") &&
      w("Acme to acquire Beta Corp") > w("Acme wins $2B contract") &&
      w("Acme wins $2B contract") > w("Regulators fine Acme") &&
      w("Regulators fine Acme") > w("Acme names new CEO") &&
      w("Acme names new CEO") > w("Analyst raises Acme price target"),
    "materiality is ranked earnings > guidance > M&A > contract > regulation > management > analyst action"
  );

  // Source quality must be a real ranking factor, with PR wires ranked below
  // genuine financial reporting.
  const src = (source: string, url = "https://example.com/a") => makeNews({ title: "Acme reports Q3 earnings", source, url });
  assert(sourceQualityScore(src("Reuters")) > sourceQualityScore(src("Yahoo Finance")), "a top-tier financial wire outranks a general finance portal");
  assert(sourceQualityScore(src("Yahoo Finance")) > sourceQualityScore(src("PR Newswire")), "genuine financial reporting outranks a press-release wire");
  assert(
    sourceQualityScore(src("The Globe and Mail", "https://theglobeandmail.com/investing/markets/pressreleases/1/")) ===
      sourceQualityScore(src("PR Newswire")),
    "a press-release URL is treated as promotional even when the host is a real newspaper"
  );
}

// ===== Section 10: 50/200-day trend is computed from data we already have,
// and is never faked from too little history =====
{
  const rising = Array.from({ length: 260 }, (_, i) => 100 + i * 0.5); // steadily up
  const upTrend = movingAverageTrend(rising);
  assert(upTrend !== null && upTrend.ma50 !== null && upTrend.ma200 !== null, "with a full year of closes, both the 50- and 200-day averages are computable");
  assert(upTrend?.aboveMa50 === true && upTrend?.aboveMa200 === true, "a steadily rising series is correctly reported as above both moving averages");

  const falling = Array.from({ length: 260 }, (_, i) => 300 - i * 0.5);
  const downTrend = movingAverageTrend(falling);
  assert(downTrend?.aboveMa50 === false && downTrend?.aboveMa200 === false, "a steadily falling series is correctly reported as below both moving averages");

  // The important guard: sma() pads short slices, so a naive implementation
  // would happily return a "200-day average" computed from 60 bars.
  const short = Array.from({ length: 60 }, (_, i) => 100 + i);
  const shortTrend = movingAverageTrend(short);
  assert(shortTrend?.ma50 !== null && shortTrend?.ma50 !== undefined, "50 days of history is enough for a 50-day average");
  assert(shortTrend?.ma200 === null, "60 bars never produce a '200-day' average – it stays null rather than being computed from a short slice");
  assert(shortTrend?.aboveMa200 === null, "with no 200-day average there is no above/below claim either");

  assert(movingAverageTrend([]) === null, "an empty price series yields no trend at all, not a crash");

  assert(
    trendLabelHebrew(upTrend) === "מעל MA50 · מעל MA200",
    `the compact trend label renders both averages (got ${trendLabelHebrew(upTrend)})`
  );
  assert(trendLabelHebrew(shortTrend)?.includes("MA200") === false, "the label omits the 200-day average entirely when it isn't computable");
  assert(trendLabelHebrew(null) === null, "no trend data means no label – the cell is omitted rather than showing a placeholder");
}

// ===== Section 5: every unavailable field carries an attributable CAUSE ====
{
  assert(providerForCacheKey("overview_AAPL") === "alphaVantage", "an OVERVIEW cache key is attributed to Alpha Vantage");
  assert(providerForCacheKey("yahoo_daily_AAPL") === "yahoo", "a Yahoo cache key is attributed to Yahoo");
  assert(providerForCacheKey("finnhub_earnings_result_AAPL_2026-09-01") === "finnhub", "a Finnhub cache key is attributed to Finnhub");
  assert(providerForCacheKey("nasdaq_earnings_2026-09-01") === "nasdaq", "a Nasdaq cache key is attributed to Nasdaq");
  assert(providerForCacheKey("movers") === "alphaVantage", "the bare 'movers' key is attributed to Alpha Vantage");

  const breakdown = summarizeProviderFailures([
    { provider: "alphaVantage", cause: "budgetSkipped", key: "overview_A" },
    { provider: "alphaVantage", cause: "budgetSkipped", key: "overview_B" },
    { provider: "alphaVantage", cause: "rateLimit", key: "overview_C" },
    { provider: "finnhub", cause: "missingApiKey", key: "news_D" },
  ]);
  assert(breakdown.total === 4, "the ledger totals every recorded failure");
  assert(
    breakdown.byCause.budgetSkipped === 2 && breakdown.byCause.rateLimit === 1 && breakdown.byCause.missingApiKey === 1,
    "a budget-skipped call, a rate limit and a missing API key are counted as THREE different causes, never lumped together"
  );
  assert(
    breakdown.byProvider.alphaVantage === 3 && breakdown.byProvider.finnhub === 1,
    "failures are simultaneously attributable by provider"
  );
}

// ===== Section 3: an unrecognized provider timing must not pin a record in
// "awaiting reaction" forever =====
{
  // Finnhub's `hour` parses to the literal string "unknown", never undefined,
  // so a plain `??` fallback silently never fires.
  assert(
    resolveReportedTiming("unknown", "pre-market") === "pre-market",
    "an 'unknown' provider timing falls back to the expected timing instead of overriding it"
  );
  assert(
    resolveReportedTiming(undefined, "post-market") === "post-market",
    "a missing provider timing falls back to the expected timing"
  );
  assert(
    resolveReportedTiming("post-market", "pre-market") === "post-market",
    "a KNOWN provider timing still wins over the expected timing – the provider is more authoritative once it reports"
  );
  assert(
    resolveReportedTiming("unknown", "unknown") === "unknown",
    "when neither source knows the timing, it stays 'unknown' – never guessed"
  );
}

// ===== Section 3: never finalize a reaction against a session that is still
// trading =====
{
  const closes: DatedClose[] = [
    { date: "2026-09-08", close: 100 },
    { date: "2026-09-09", close: 110 }, // "today" – still in progress while the market is open
  ];
  const duringSession = new Date("2026-09-09T17:00:00Z");  // 13:00 New York – OPEN
  const afterSession = new Date("2026-09-09T21:00:00Z");   // 17:00 New York – closed

  assert(
    excludeUnsettledSession(closes, duringSession).length === 1,
    "while the US session is still trading, that day's unsettled bar is dropped from the price history"
  );
  assert(
    excludeUnsettledSession(closes, afterSession).length === 2,
    "once the US session has closed, that day's bar is a real close and is kept"
  );

  assert(
    computeEarningsReaction(closes, "2026-09-09", "pre-market", duringSession) === null,
    "a pre-market earnings reaction is NOT finalized against an intraday price while the session is still open"
  );
  const settled = computeEarningsReaction(closes, "2026-09-09", "pre-market", afterSession);
  assert(
    settled !== null && settled.reactionPercent === 10,
    "the same reaction IS computed once that session has actually closed"
  );
}

// ===== Section 4: the tracker file can never be left half-written =====
{
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "tracker-atomic-"));
  const file = path.join(tmpDir, "earnings-tracker.json");
  const records: EarningsTrackingRecord[] = [
    {
      ticker: "PANW",
      name: "Palo Alto Networks, Inc.",
      earningsDate: "2026-09-01",
      expectedTiming: "post-market",
      status: "awaiting",
      firstSeenAt: "2026-08-30T14:26:37.000Z",
      lastSeenAt: "2026-08-30T14:26:37.000Z",
    },
  ];
  saveTracker(records, file);
  assert(!fs.existsSync(`${file}.tmp`), "saveTracker leaves no .tmp file behind – the rename completed");
  assert(loadTracker(file).length === 1, "the atomically written tracker round-trips through loadTracker");

  // Guard the real hazard: loadTracker swallows parse errors and returns [],
  // so a torn write would silently erase all reported earnings history rather
  // than failing loudly.
  fs.writeFileSync(file, '[{"ticker":"PANW","earnings', "utf8");
  assert(loadTracker(file).length === 0, "sanity: a truncated file really does read back as empty – which is exactly why the write must be atomic");
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ===== Duplicate-send guard: one report per US trading date =====
//
// The external scheduler is a second system that can fire twice. GitHub's
// `concurrency` group serializes runs but does not make them idempotent, so this
// state file is what actually stops a second email.
{
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "report-state-"));
  const file = path.join(tmpDir, "report-state.json");

  // A missing file must read as "nothing sent", never as "already sent" – the
  // safe direction is at worst one duplicate, never a permanently suppressed report.
  assert(loadReportState(file).lastSentUsTradingDate === null, "a missing send-state file reads as 'nothing sent yet'");

  saveReportState(
    {
      lastSentUsTradingDate: "2026-09-16",
      lastSentAtIso: "2026-09-16T12:58:41.123Z",
      lastSentMessageId: "<abc@mail>",
      lastSentRunId: "35002540222",
      lastSentEvent: "workflow_dispatch",
    },
    file
  );
  assert(!fs.existsSync(`${file}.tmp`), "saveReportState leaves no .tmp behind – the atomic rename completed");
  const roundTripped = loadReportState(file);
  assert(
    roundTripped.lastSentUsTradingDate === "2026-09-16" && roundTripped.lastSentEvent === "workflow_dispatch",
    "the send-state round-trips through save/load"
  );

  // The gate itself.
  assert(
    alreadySentForTradingDate("2026-09-16", "2026-09-16"),
    "a second trigger on a trading date already sent is recognised as a duplicate"
  );
  assert(
    !alreadySentForTradingDate("2026-09-15", "2026-09-16"),
    "a new trading date is NOT treated as a duplicate – yesterday's send must not suppress today's report"
  );
  assert(
    !alreadySentForTradingDate(null, "2026-09-16"),
    "an empty state (first ever run, or an unreadable file) never suppresses the send"
  );

  // A corrupt file must not read as "already sent", which would silently stop
  // the report going out for good.
  fs.writeFileSync(file, '{"lastSentUsTradingDate":"2026-09-1', "utf8");
  assert(
    loadReportState(file).lastSentUsTradingDate === null,
    "a torn/corrupt send-state file reads as 'nothing sent' rather than suppressing the report"
  );
  assert(parseReportState("not json at all").lastSentUsTradingDate === null, "unparseable send-state is tolerated");
  assert(parseReportState(null).lastSentUsTradingDate === null, "absent send-state is tolerated");
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ===== Performance state: a re-run must CONVERGE, not accumulate =====
{
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "perf-state-"));
  const snapshot = {
    tradingDate: "2026-09-16",
    generatedAt: "2026-09-16T12:58:00.000Z",
    market: "US" as const,
    runDataQuality: 61,
    freshness: "degraded" as const,
    recommendationsThisRun: 3,
    openCount: 5,
    closedCount: 3,
    winRate: 0.667,
    avgReturnPct: 1.15,
    calibrationError: 0.1,
    avgConfidence: 0.59,
  };

  upsertRunSnapshot(tmpDir, snapshot);
  upsertRunSnapshot(tmpDir, { ...snapshot, generatedAt: "2026-09-16T13:30:00.000Z", openCount: 6 });
  const sameDay = loadRunSnapshots(tmpDir);
  assert(
    sameDay.length === 1,
    `two runs on the same trading date leave exactly one trend snapshot, not two (got ${sameDay.length}) – this is what stops a double trigger permanently skewing the trend history`
  );
  assert(sameDay[0].openCount === 6, "the later run's snapshot replaces the earlier one for that trading date");

  // A genuinely different trading date must still accumulate.
  upsertRunSnapshot(tmpDir, { ...snapshot, tradingDate: "2026-09-17", generatedAt: "2026-09-17T12:58:00.000Z" });
  const twoDays = loadRunSnapshots(tmpDir);
  assert(twoDays.length === 2, `a new trading date appends a snapshot (got ${twoDays.length})`);
  assert(
    twoDays[0].tradingDate === "2026-09-16" && twoDays[1].tradingDate === "2026-09-17",
    "trend snapshots stay ordered by trading date"
  );

  // Atomicity of the ledger write – the path that would otherwise silently
  // discard the entire recommendation history on a torn write.
  saveLedger(tmpDir, []);
  assert(
    !fs.existsSync(path.join(tmpDir, "performance", "ledger.json.tmp")),
    "saveLedger leaves no .tmp behind – the atomic rename completed"
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ===== Ledger ids stay unique even when a symbol closes and reopens same-day =====
//
// The id is `market:symbol@date`, which collides if a position closes and the
// same symbol is recommended again on the same calendar day. Unreachable with one
// run per day; reachable the moment an external scheduler double-fires.
{
  const closedSameDay = [
    {
      id: "US:MSFT@2026-09-16",
      symbol: "MSFT",
      score: 8,
      confidence: 0.7,
      entryPrice: 400,
      dataQuality: 90,
      action: "accumulate" as const,
      horizonDays: 30,
      market: "US" as const,
      recommendedAt: "2026-09-16T06:00:00.000Z",
      targetDate: "2026-10-16T06:00:00.000Z",
      status: "closed" as const,
    },
  ];
  const after = recordRecommendations(
    closedSameDay,
    "US",
    [
      {
        symbol: "MSFT",
        score: 9,
        confidence: 0.8,
        entryPrice: 420,
        dataQuality: 95,
        action: "accumulate",
        horizonDays: 30,
      },
    ],
    "2026-09-16T12:58:00.000Z"
  );
  assert(after.length === 2, "the symbol is re-opened after its earlier position closed");
  assert(
    new Set(after.map((r) => r.id)).size === after.length,
    `ledger ids remain unique after a same-day close-and-reopen (got ${after.map((r) => r.id).join(", ")})`
  );
}

// ===== The production-run gate lives in the workflow, so assert it there =====
//
// IS_PRODUCTION_RUN is defined in YAML on purpose: both the Node process and the
// state-persistence step must agree on one answer, and deriving it twice is how a
// test run ends up mailing the real distribution list and writing shared state.
// That puts the single most safety-critical expression in the repo outside
// TypeScript's reach, so it is pinned here as text instead of left unguarded.
{
  const wf = fs.readFileSync(path.join(".github", "workflows", "daily-stock-report.yml"), "utf8");

  // --- the authorized external trigger ---
  assert(/^\s*workflow_dispatch:/m.test(wf), "the workflow is triggerable by workflow_dispatch (the external scheduler's endpoint)");
  assert(
    !/^\s*repository_dispatch:/m.test(wf),
    "no repository_dispatch TRIGGER remains – it would require a Contents: write PAT, which can push code and therefore read the email/API secrets"
  );
  assert(
    /production_run:\s*\n\s*description:[\s\S]*?required:\s*false\s*\n\s*default:\s*false\s*\n\s*type:\s*boolean/.test(wf),
    "production_run is declared with an explicit `default: false` and `type: boolean` – the default is what makes an unset value deterministic rather than empty"
  );

  // --- the production condition itself ---
  const prodCondition = wf.match(/IS_PRODUCTION_RUN:\s*\$\{\{([\s\S]*?)\}\}/);
  assert(!!prodCondition, "IS_PRODUCTION_RUN is defined once, at job level");
  const cond = prodCondition![1].replace(/\s+/g, " ");
  assert(
    cond.includes("github.event_name == 'schedule'"),
    `the native cron still counts as production during migration phase 1, so we never create a day with no scheduler (got: ${cond})`
  );
  assert(
    cond.includes("github.event_name == 'workflow_dispatch'") && cond.includes("github.event.inputs.production_run == 'true'"),
    `an external workflow_dispatch is production ONLY when production_run is the string 'true' (got: ${cond})`
  );
  assert(
    !/&&\s*github\.event\.inputs\.production_run\s*\)/.test(wf),
    "production_run is never used as a bare truthy value – a boolean input arrives as the STRING 'false', which is truthy, so a bare test would make every manual run production"
  );

  // --- a manual run cannot reach the real distribution list ---
  assert(
    /EMAIL_TO:\s*\$\{\{\s*github\.event\.inputs\.test_recipient\s*\|\|\s*secrets\.EMAIL_TO\s*\}\}/.test(wf),
    "a test_recipient override replaces the real EMAIL_TO list"
  );
  assert(
    /EMAIL_BCC:\s*\$\{\{\s*github\.event\.inputs\.test_recipient\s*&&\s*''\s*\|\|\s*secrets\.EMAIL_BCC\s*\}\}/.test(wf),
    "a test_recipient override also empties EMAIL_BCC – otherwise a 'test' would still blind-copy the real distribution list"
  );
  assert(
    /production_run == 'true'[\s\S]{0,160}test_recipient != ''/.test(wf),
    "production_run combined with test_recipient is rejected – it would mail the test address and then record the trading date as delivered, suppressing the day's real report"
  );

  // --- state persistence is gated on the same single definition ---
  assert(
    /if:\s*always\(\)\s*&&\s*env\.IS_PRODUCTION_RUN\s*==\s*'true'/.test(wf),
    "the persist step is gated on the same IS_PRODUCTION_RUN, not on a second, independently-derived condition"
  );
  for (const p of ["data/earnings-tracker.json", "data/report-state.json", "reports/performance"]) {
    assert(wf.includes(`git add -- ${p}`), `the persist step stages ${p}`);
  }
  assert(
    !/git add -- reports\/(daily-stock-report|latest|run-status|email-preview)/.test(wf),
    "the persist step never stages generated report output – only rolling state"
  );

  // --- migration phase 1 must not leave a scheduler gap ---
  assert(
    /-\s*cron:\s*'58 12 \* 3-10 1-5'/.test(wf) && /-\s*cron:\s*'58 13 \* 1-3,10-12 1-5'/.test(wf),
    "both seasonal production crons are still present during migration – they are the only delivery path until cron-job.org is proven"
  );
  assert(
    /MAX_LATENESS_MINUTES:\s*"240"/.test(wf),
    "the migration-phase lateness override is present, so cron runs still deliver while GitHub starts them 41–204 min late"
  );
  assert(
    MAX_LATENESS_MINUTES === 30,
    `the CODE default remains the intended production value of 30, so phase 2 is a YAML-only change (got ${MAX_LATENESS_MINUTES})`
  );
}

runAsyncOnlyChecks()
  .catch((err) => {
    console.error("💥 Unexpected error during async self-test checks:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    console.log(
      process.exitCode ? "\n💥 content validation self-test FAILED" : "\n🎉 content validation self-test PASSED"
    );
  });
