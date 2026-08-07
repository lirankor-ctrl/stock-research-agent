// Deterministic content-validation checks for the newsletter's reliability
// and quality rules (no live API calls – synthetic inputs only).
//
//   npm run content:selftest

import { computeDataQuality } from "./dataQuality";
import { deriveEarningsCalendarFromRows } from "./earningsCalendar";
import { deriveEarningsFollowUpFromRows } from "./earningsFollowUp";
import { generateEmailHtmlBody, generateEmailTextBody } from "./emailBodyGenerator";
import { buildTopOpportunities, EMERGENCY_MODE_LABEL, passesEmergencySafetyFilter } from "./emergencyMode";
import { passesLongTermFilter } from "./filters";
import { generateHtmlReport } from "./htmlReportGenerator";
import { selectMarketStory } from "./marketStory";
import { MIN_VISIBLE_INDICATORS, visibleOverviewItems } from "./marketOverview";
import { NasdaqEarningsRow } from "./nasdaqEarnings";
import { isPromotionalOrLegalNews } from "./newsFilter";
import { buildOpportunityThesis } from "./opportunityThesis";
import { validatePresentation } from "./presentationValidation";
import { generateReport } from "./reportGenerator";
import { EMAIL_MAX_WIDTH, formatOverviewValue, weekAheadExtraEarnings } from "./reportPresentation";
import { validateReportConsistency } from "./reportValidation";
import { computeTechnicals } from "./technicals";
import { DataQuality, EnrichedStock, MarketOverviewItem, NewsItem, ReportData } from "./types";

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
    marketStory: null,
    additionalHeadlines: [],
    core: [stockWithOnlyInstitutionalNews],
    growth: [],
    speculative: [],
    topOpportunities: [],
    topOpportunitiesEmergencyMode: false,
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
    earningsFollowUp: { entries: [], status: "noneFound" },
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

// ===== Earnings Follow-up: same tri-state discipline as the forward-looking
// calendar – "unavailable" and "no recent reports" must never collapse =====
{
  const rowsByDate = [
    { dateIso: "2026-07-24", rows: [] as NasdaqEarningsRow[] },
    { dateIso: "2026-07-22", rows: [nasdaqRow({ symbol: "meta" })] },
  ];
  const result = deriveEarningsFollowUpFromRows(rowsByDate, { nowIso: "2026-07-29" });
  assert(result.status === "confirmed", "known recent earnings report -> status 'confirmed'");
  const meta = result.entries.find((e) => e.ticker === "META");
  assert(!!meta, "META follow-up entry is present");
  assert(meta?.daysAgo === 7, "META daysAgo computed correctly (2026-07-22 -> 2026-07-29 = 7)");

  const allFailed = deriveEarningsFollowUpFromRows(
    [{ dateIso: "2026-07-22", rows: null }],
    { nowIso: "2026-07-29" }
  );
  assert(allFailed.status === "unavailable", "every date's fetch failing -> status 'unavailable', not 'noneFound'");

  const genuinelyEmpty = deriveEarningsFollowUpFromRows(
    [{ dateIso: "2026-07-22", rows: [] }],
    { nowIso: "2026-07-29" }
  );
  assert(genuinelyEmpty.status === "noneFound", "a real (successful) empty lookback -> status 'noneFound'");
  assert(allFailed.status !== genuinelyEmpty.status, "'unavailable' and 'noneFound' are never the same status here either");
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
    marketStory: null,
    additionalHeadlines: [],
    core: [opp],
    growth: [],
    speculative: [],
    topOpportunities: [opp],
    topOpportunitiesEmergencyMode: false,
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
    earningsFollowUp: { entries: [], status: "noneFound" },
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
    marketStory: null,
    additionalHeadlines: [],
    core: [oppA],
    growth: [oppB],
    speculative: [],
    topOpportunities: [oppA, oppB],
    topOpportunitiesEmergencyMode: false,
    opportunityTheses: new Map(),
    watchlist: [oppA, oppB],
    technicalWatch: [
      { ticker: "OPPA", name: "Opportunity A", price: 120, changePercent: 1.5, rsi14: 55, statusHebrew: "ניטרלי" },
      { ticker: "OPPB", name: "Opportunity B", price: 0, changePercent: 0, rsi14: null, statusHebrew: "לא זמין" },
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
    earningsFollowUp: { entries: [], status: "noneFound" },
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
      marketStory: null,
      additionalHeadlines: [],
      core: [],
      growth: [],
      speculative: [],
      topOpportunities: [],
      topOpportunitiesEmergencyMode: false,
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
      earningsFollowUp: { entries: [], status: "noneFound" },
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
  const goodCandidate = makeStock({ ticker: "GOOD", price: 100, finalScore: 8, dataQuality: makeDQ() });
  const weakCandidate = makeStock({ ticker: "WEAK", price: 50, finalScore: 5, dataQuality: makeDQ({ label: "Low", coverageScore: 40, confidenceScore: 30 }) });
  const normalResult = buildTopOpportunities([goodCandidate, weakCandidate], 3);
  assert(normalResult.emergencyModeActive === false, "normal mode is used automatically when at least one candidate meets the quality bar");
  assert(!normalResult.stocks.some((s) => s.emergencyMode), "no stock is marked emergencyMode when normal mode is used");
  assert(normalResult.stocks.length === 1 && normalResult.stocks[0].ticker === "GOOD", "normal mode only includes candidates that actually clear the quality bar");

  // --- 5b. buildTopOpportunities: Emergency Mode engages only when NOTHING clears the bar ---
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
  assert(
    emergencyResult.stocks.length === 1 && emergencyResult.stocks[0].ticker === "DEGA",
    "Emergency Mode still excludes the no-price and confirmed-bad-news candidates even though they scored higher"
  );
  assert(
    emergencyResult.stocks.every((s) => s.emergencyMode === true),
    "every stock promoted through Emergency Mode is explicitly tagged emergencyMode: true"
  );
  assert(
    emergencyResult.stocks[0].emergencyMode === true && degradedA.emergencyMode === undefined,
    "Emergency Mode never presents a stock as a normal high-confidence pick – it returns a tagged copy, the original candidate object is untouched"
  );

  // A run with literally no safety-passing candidate at all stays empty rather than fabricating a pick.
  const allUnsafe = buildTopOpportunities([degradedNoPrice, degradedBankrupt], 3);
  assert(allUnsafe.stocks.length === 0 && allUnsafe.emergencyModeActive === false, "Emergency Mode never fabricates a candidate when literally nothing passes the safety filter");

  // --- 6. Emergency candidates are visibly marked across all four render surfaces ---
  const emergencyStock = emergencyResult.stocks[0];
  const emergencyReportData = makeReportData({
    topOpportunities: [emergencyStock],
    topOpportunitiesEmergencyMode: true,
    watchlist: [emergencyStock],
  });
  const emMd = generateReport(emergencyReportData);
  const emHtml = generateHtmlReport(emergencyReportData);
  const emEmailHtml = generateEmailHtmlBody(emergencyReportData, "2026-08-07");
  const emEmailText = generateEmailTextBody(emergencyReportData, "2026-08-07");
  assert(emMd.includes(EMERGENCY_MODE_LABEL), "Markdown attachment visibly labels the Emergency Mode candidate");
  assert(emHtml.includes(EMERGENCY_MODE_LABEL), "HTML attachment visibly labels the Emergency Mode candidate");
  assert(emEmailHtml.includes(EMERGENCY_MODE_LABEL), "Email HTML body visibly labels the Emergency Mode candidate");
  assert(emEmailText.includes(EMERGENCY_MODE_LABEL), "Email text body visibly labels the Emergency Mode candidate");

  // Regression guard: a normal-mode report (emergencyModeActive: false, no tagged
  // stock) must NEVER show the Emergency Mode label anywhere.
  const normalReportData = makeReportData({
    topOpportunities: [goodCandidate],
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

console.log(
  process.exitCode ? "\n💥 content validation self-test FAILED" : "\n🎉 content validation self-test PASSED"
);
