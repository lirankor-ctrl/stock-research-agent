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
import { buildInterpretation, classifyBeatMiss, computeEarningsReaction, computeSurprisePct } from "./earningsReaction";
import {
  ClosesFetcher,
  filterOutReported,
  loadTracker,
  pruneOldRecords,
  ResultsFetcher,
  runEarningsTracker,
  saveTracker,
  selectDisplayRecords,
  upsertTrackedEarnings,
} from "./earningsTracker";
import { generateEmailHtmlBody, generateEmailTextBody } from "./emailBodyGenerator";
import { buildTopOpportunities, EMERGENCY_MODE_LABEL, passesEmergencySafetyFilter } from "./emergencyMode";
import { passesLongTermFilter } from "./filters";
import { generateDiagnosticHtmlReport, generateHtmlReport } from "./htmlReportGenerator";
import { DatedClose } from "./marketData";
import { selectMarketStory } from "./marketStory";
import { MIN_VISIBLE_INDICATORS, visibleOverviewItems } from "./marketOverview";
import { NasdaqEarningsRow } from "./nasdaqEarnings";
import { isEtfOrLeveragedFundNews, isPromotionalOrLegalNews } from "./newsFilter";
import { buildOpportunityThesis } from "./opportunityThesis";
import { validatePresentation } from "./presentationValidation";
import { computeProvenance, extractProvenance } from "./reportFingerprint";
import { generateDiagnosticReport, generateReport } from "./reportGenerator";
import { buildReportHealth, formatReportHealth } from "./reportHealth";
import { EMAIL_MAX_WIDTH, formatOverviewValue, weekAheadExtraEarnings } from "./reportPresentation";
import { computeReportQuality, RECOVERY_THRESHOLD, ReportQuality, SEND_THRESHOLD } from "./reportQuality";
import { classifyReportTiming, DELAYED_THRESHOLD_MINUTES, usMarketState } from "./reportTiming";
import { validateReportConsistency } from "./reportValidation";
import { resolveTechnicalWatchPrice } from "./technicalAlerts";
import { computeTechnicals } from "./technicals";
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
  // early schedule (10:00 Israel) so a 50min delay still lands hours before
  // the US market opens, rather than crossing into "intraday" first.
  const isolatedDelay = classifyReportTiming({
    now: new Date("2026-08-28T07:50:00Z"), // 10:50 IDT
    scheduledHourIsrael: 10,
    scheduledMinuteIsrael: 0,
    isManualRun: false,
  });
  assert(
    isolatedDelay.status === "delayed" && isolatedDelay.delayMinutes === 50,
    `a run more than ${DELAYED_THRESHOLD_MINUTES}min late but still genuinely pre-market is labeled "delayed" specifically (got status=${isolatedDelay.status} delay=${isolatedDelay.delayMinutes})`
  );

  const intraday = classifyReportTiming({
    now: openNy,
    scheduledHourIsrael: 16,
    scheduledMinuteIsrael: 5,
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
      const fullCloses: ClosesFetcher = async () => ({
        value: [
          { date: "2026-08-25", close: 200 },
          { date: "2026-08-26", close: 202 },
          { date: "2026-08-27", close: 192.7 }, // next session close after the after-market report
        ],
        source: { source: "live" },
      });
      const run3 = await runEarningsTracker({
        filePath, now: new Date("2026-08-27T13:00:00.000Z"), upcomingEntries: [panwEntry],
        fetchResults: resultAvailable, fetchCloses: fullCloses,
      });
      const panwAfterRun3 = run3.records.find((r) => r.ticker === "PANW");
      assert(
        panwAfterRun3?.status === "reported",
        `RUN 3: PANW transitions to 'reported' once actuals AND the reaction are both available (got ${panwAfterRun3?.status})`
      );
      assert(
        panwAfterRun3?.result?.actualEps === 1.08 && panwAfterRun3?.result?.epsSurprisePct !== null,
        "RUN 3: actual EPS and a computed surprise% are stored"
      );
      assert(
        panwAfterRun3?.result?.reaction != null,
        "RUN 3: stock reaction is calculated once sufficient market data exists"
      );
      assert(
        run3.coverage.resultsFound === 1 && run3.coverage.reactionsCalculated === 1,
        "RUN 3: coverage reflects one result found with a calculated reaction"
      );

      // ----- RUN 4: fresh process again -----
      const failIfCalled = async (): Promise<never> => {
        throw new Error("should not be called for an already-reported record");
      };
      const run4 = await runEarningsTracker({
        filePath, now: new Date("2026-08-28T13:00:00.000Z"), upcomingEntries: [panwEntry], // Nasdaq might still list it briefly
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

      // Wednesday: the next regular-session close now exists.
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
        filePath, now: new Date("2026-08-26T13:00:00.000Z"), upcomingEntries: [tuesdayEntry],
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
