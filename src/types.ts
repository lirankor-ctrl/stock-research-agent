import { ReportQuality } from "./reportQuality";

export type StockCategory = "gainer" | "loser" | "active";

// Where a candidate entered the pipeline from.
export type StockOrigin = "watchlist" | "mover";

// Long-term opportunity bucket assigned after enrichment + scoring.
export type OpportunityTier = "core" | "growth" | "speculative" | "none";

export interface RawMover {
  ticker: string;
  price: string;
  change_amount: string;
  change_percentage: string;
  volume: string;
}

export interface AlphaVantageMoversResponse {
  metadata?: string;
  last_updated?: string;
  top_gainers?: RawMover[];
  top_losers?: RawMover[];
  most_actively_traded?: RawMover[];
  Note?: string;
  Information?: string;
}

export interface CompanyProfile {
  symbol: string;
  name?: string;
  exchange?: string;
  sector?: string;
  industry?: string;
  marketCap?: number;
  description?: string;
  country?: string;
  peRatio?: number;
  eps?: number;           // trailing EPS – used to detect negative earnings
  profitMargin?: number;  // net profit margin (e.g. 0.21 = 21%)
  dividendPerShare?: number; // annual dividend per share, from Alpha Vantage OVERVIEW
  dividendYield?: number;    // e.g. 0.015 = 1.5%
  exDividendDate?: string;   // YYYY-MM-DD, "None" mapped to undefined
  dividendDate?: string;     // next payment date, YYYY-MM-DD
}

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary?: string;
  sentimentScore?: number;
  sentimentLabel?: string;
  relevanceScore?: number;
}

export interface Stock {
  ticker: string;
  price: number;
  changePercent: number;
  volume: number;
  category: StockCategory;
  origin: StockOrigin;
  preScore: number;
  quoteSource?: SourceInfo; // where price/volume came from (movers list = always present)
}

export interface ScoreBreakdown {
  companyQuality: number; // 0..10 – 40% weight
  momentum: number;       // 0..10 – 20% weight
  volume: number;         // 0..10 – 20% weight
  newsQuality: number;    // 0..10 – 20% weight
  penalty: number;        // 0..1 multiplier applied to the weighted score
  total: number;          // 1..10 final
}

export type DataSource = "live" | "cached" | "unavailable";

export interface SourceInfo {
  source: DataSource;
  ageHours?: number; // populated when source === "cached"
}

// ===== Data quality =====

// Status of a single data dimension:
// - "available":     fetched LIVE this run and the field is populated.
// - "cached":        no live fetch, but a cached value is populated. Counts
//                    the same as "available" for scoring – we DO have a
//                    usable value, just not freshly fetched.
// - "genuinelyMissing": we successfully reached the data source (live or
//                    cached) but the field itself is confirmed absent (e.g.
//                    OVERVIEW returned with no market cap). Lowers the score.
// - "rateLimited":   we attempted to fetch and got nothing usable (live call
//                    failed AND no cache). An availability issue, NOT a
//                    data-quality issue – excluded from the score entirely.
// - "notRequested":  this dimension was never attempted for this stock (e.g.
//                    no quote source at all). Also excluded from the score –
//                    it must never be silently counted as complete.
export type DimensionStatus =
  | "available"
  | "cached"
  | "genuinelyMissing"
  | "rateLimited"
  | "notRequested";

export interface DataQualityStatuses {
  price: DimensionStatus;
  volume: DimensionStatus;
  marketCap: DimensionStatus;
  profile: DimensionStatus;
  news: DimensionStatus;
  technical: DimensionStatus;
}

export type DataQualityLabel = "High" | "Medium" | "Low" | "Excluded";

export interface DataQuality {
  statuses: DataQualityStatuses;
  // Coverage: how much of the data was successfully retrieved at all
  // (0..100), computed ONLY over assessable dimensions. This drives the
  // High/Medium/Low/Excluded label and the recommendation gate.
  coverageScore: number;
  // Confidence: how reliable/recent that data is (0..100). Starts from
  // coverage and is reduced by cache staleness and by any optional
  // (non-critical) data we don't have live-fresh – e.g. missing technical
  // data never excludes a stock, but it always keeps confidence below 100.
  // A perfect 100 requires everything to be live AND complete, so it's rare
  // by design.
  confidenceScore: number;
  label: DataQualityLabel;
  // true when the stock cannot be ranked/recommended: either critical data is
  // genuinely missing, or (critically) there is no usable price at all – live
  // or cached – regardless of WHY the price is unavailable.
  excluded: boolean;
  missing: string[];         // Hebrew – genuinely missing dimensions (lower coverage)
  rateLimited: string[];     // Hebrew – rate-limited or never-requested (do NOT lower coverage)
  reliabilityHebrew: string; // Hebrew explanation of how reliable the signal is
}

export interface EnrichedStock extends Stock {
  profile?: CompanyProfile;
  news: NewsItem[];
  whyHebrew: string;
  longTermWhyHebrew: string; // "למה משקיע ארוך טווח צריך להתעניין במניה"
  tier: OpportunityTier;
  score: ScoreBreakdown;
  finalScore: number;
  profileSource: SourceInfo;
  newsSource: SourceInfo;
  dataQuality?: DataQuality; // attached after the technical phase in the pipeline
  // true only when this stock was promoted into Top Opportunities by
  // Emergency Report Mode (see src/emergencyMode.ts) rather than clearing
  // the normal High/Medium quality bar. Every renderer MUST show the
  // "Reduced Confidence / Emergency Mode" label when this is true.
  emergencyMode?: boolean;
}

// CNN Fear & Greed Index – overall market sentiment.
export type FearGreedRating =
  | "extreme fear"
  | "fear"
  | "neutral"
  | "greed"
  | "extreme greed";

export interface FearGreed {
  score: number;          // 0..100
  rating: string;         // raw CNN rating (lower-case)
  classification: string; // display label, e.g. "Extreme Fear"
  hebrew: string;         // short Hebrew explanation, e.g. "שוק במצב פחד"
}

// ===== Technical alerts (Bollinger Bands + RSI) =====

// A single stock that closed outside its Bollinger Bands.
export interface TechnicalAlert {
  ticker: string;
  name: string;
  price: number;       // latest close
  band: number;        // the breached band value (upper or lower)
  pctFromBand: number; // magnitude away from the band, in %, always positive
  rsi14: number;
}

// A stock approaching (but not yet breaching) a Bollinger Band.
export interface BandProximity {
  ticker: string;
  name: string;
  price: number;       // latest close
  distancePct: number; // % distance to the band (smaller = closer to crossing)
  rsi14: number;
}

// A stock whose Bollinger Band width has expanded the most recently.
export interface ExpansionItem {
  ticker: string;
  name: string;
  widthChangePct: number; // % change in band width vs the lookback window
  rsi14: number;
}

export interface TechnicalAlerts {
  aboveUpper: TechnicalAlert[]; // price above the upper band (possibly overbought)
  belowLower: TechnicalAlert[]; // price below the lower band (possibly oversold)
  // Fallbacks so the section is never empty:
  closestToUpper: BandProximity[]; // top names nearing the upper band
  closestToLower: BandProximity[]; // top names nearing the lower band
  expansion: ExpansionItem[];      // top names by recent band-width increase
  // True when NO usable daily data could be obtained (rate-limited and no cache).
  // Renderers show a clear notice instead of empty tables. Not a data-quality fault.
  dataUnavailable: boolean;
}

// ===== Market Story of the Day =====

// One curated news story (real headline/source/url – never fabricated) used as
// the newsletter hero. `logoUrl` is populated only from a safe/licensed source;
// otherwise renderers fall back to a styled ticker placeholder.
export interface MarketStory {
  ticker: string;
  companyName: string;
  headline: string;
  url: string;
  source: string;
  publishedAt: string;        // raw Alpha Vantage timestamp (YYYYMMDDTHHMMSS)
  publishedDisplay: string;   // formatted "YYYY-MM-DD HH:MM"
  sentimentLabel?: string;    // raw label from the feed (e.g. "Bullish")
  summaryHebrew: string;      // 3–5 sentence Hebrew framing built from real facts
  whyMattersHebrew: string;   // why a long-term investor should care
  originalSummary?: string;   // the source's own (English) summary, verbatim
  priceMove?: { price: number; changePercent: number };
  logoUrl?: string;           // only when a safe public logo is available
  // true when this story was NOT found within the primary 24h window and
  // came from the 48h fallback window instead – every renderer MUST show
  // the literal fallback notice below when this is true (see
  // src/marketStory.ts's FALLBACK_NOTICE), so an older story is never
  // presented as if it were today's news.
  isFallback: boolean;
  materialityCategory: string; // e.g. "earningsGuidance", "ma", "none" – see newsFilter.ts
}

// ===== Earnings calendar =====

export type EarningsUrgency = "today" | "tomorrow" | "week" | "later";

// Tri-state result so "no confirmed earnings" is never confused with
// "we couldn't verify" – the two must never share a message.
// - "confirmed":  we have real data and at least one entry matched.
// - "noneFound":  we have real data (live or cached) and genuinely no
//                 tracked company reports in the window.
// - "unavailable": we could not fetch or find any cached calendar data at
//                 all – we simply don't know, and must not claim "none".
export type EarningsCalendarStatus = "confirmed" | "noneFound" | "unavailable";

export interface EarningsCalendarEntry {
  ticker: string;
  name: string;
  reportDate: string;      // YYYY-MM-DD, from Nasdaq's public earnings calendar
  daysRemaining: number;   // 0 = today
  urgency: EarningsUrgency;
  estimatedEps?: number;   // Nasdaq "epsForecast", when present
  // Nasdaq's calendar (primary source) never provides this – stays undefined
  // for those rows. Populated only when the Finnhub secondary/fallback
  // provider is configured and supplies a revenue estimate for this date.
  estimatedRevenue?: number;
  timeOfDay?: "pre-market" | "post-market"; // real Nasdaq "time" column, when verified
  // 1–3 specific, real-data-driven reasons this report matters – sector
  // framing plus (when derivable) a concrete YoY EPS-forecast comparison.
  // Never a fabricated fact about the company or quarter.
  reasonsHebrew: string[];
  priority: "watchlist" | "topOpportunity" | "megaCap";
}

// ===== Market catalyst =====

export interface MarketCatalyst {
  headline: string;         // e.g. "NVIDIA Earnings"
  ticker: string;
  reportDate: string;
  daysRemaining: number;
  timingHebrew: string;     // e.g. "בעוד 3 ימים" / "מחר" / "היום"
}

// Same tri-state reasoning as EarningsCalendarStatus – "no catalyst" and
// "couldn't verify" must never render the same message.
export type MarketCatalystStatus = "confirmed" | "noneFound" | "unavailable";

export interface MarketCatalystResult {
  catalyst: MarketCatalyst | null;
  status: MarketCatalystStatus;
}

// ===== Market overview =====

export interface MarketOverviewItem {
  key: string;              // stable id, e.g. "nasdaq", "vix", "btc"
  label: string;            // display label, e.g. "NASDAQ (QQQ)"
  value: number | null;     // null => unavailable
  changePercent: number | null;
  unit?: string;            // e.g. "%", "$"
  noteHebrew?: string;      // very short explanation when relevant
  isProxy: boolean;         // true when this is an ETF/asset proxy, not the literal index
  proxyOfHebrew?: string;   // e.g. "מדד VIX (דרך VIXY ETF)"
  source: SourceInfo;
}

// ===== Economic indicators (latest released reading, not a forward calendar) =====

export interface EconomicReading {
  key: string;       // "cpi" | "unemployment" | "gdp" | "fedFundsRate"
  label: string;
  value: number | null;
  unit: string;
  asOfDate: string | null; // date the reading was released, YYYY-MM-DD
  source: SourceInfo;
}

// ===== Earnings tracking (persisted across runs – data/earnings-tracker.json,
// committed back to the repo by the workflow so it survives GitHub Actions'
// fresh checkouts; see src/earningsTracker.ts and the workflow's "Persist
// rolling state" step) =====
//
// Lifecycle: a company entering the Upcoming Earnings Calendar is upserted
// into the tracker as "awaiting". On every run, tracked records whose
// expected date has passed or is today are checked against the results
// provider. Once actual EPS/revenue figures are found:
//   - if the stock-reaction close is ALSO already available -> "reported"
//     (fully complete).
//   - if not (e.g. an after-market report Tuesday evening – the next
//     regular-session close doesn't exist until Wednesday's close) ->
//     "reportedAwaitingReaction". This is re-checked on every subsequent
//     run (cheaply – actual figures are already known, only the reaction
//     is retried) until the reaction becomes computable, at which point it
//     completes to "reported". A reaction is NEVER estimated or guessed in
//     this interim state – see computeEarningsReaction in
//     src/earningsReaction.ts, which returns null rather than a partial
//     figure when the required close doesn't exist yet.
// "resultsUnavailable" only after RESULTS_GRACE_DAYS with no confirmed
// actuals at all (provider unconfigured/unreachable, or genuinely has
// nothing) – never fabricated, and the record is still retained (not
// discarded) for the full 90-day retention window either way.
// Identity = ticker + earningsDate, so the same event can never appear as
// both upcoming and reported.

export type EarningsTimingExpectation = "pre-market" | "post-market" | "unknown";
export type EarningsTrackingStatus =
  | "awaiting"
  | "reportedAwaitingReaction"
  | "reported"
  | "resultsUnavailable";

export interface EarningsTrackingRecord {
  ticker: string;
  name: string;
  earningsDate: string; // YYYY-MM-DD (expected date) – identity key together with ticker
  expectedTiming: EarningsTimingExpectation;
  expectedEps?: number;
  expectedRevenue?: number;
  firstSeenAt: string; // ISO – first run this event was seen in Upcoming Earnings Calendar
  lastSeenAt: string;  // ISO – most recent run this event was (re)seen or (re)checked
  status: EarningsTrackingStatus;
  result?: EarningsResult;
}

// Whether actual figures were genuinely obtained – never "available" without
// a real fetched value, never silently defaulted to "unavailable" when the
// truth is simply "hasn't reported yet" (a normal, expected transient state,
// not a data failure).
export type EarningsFigureStatus = "available" | "unavailable" | "notYetReported";

// Which of the two documented reaction rules produced this calculation –
// see src/earningsReaction.ts. Computed only from REAL trading-day closes
// (Yahoo daily history), which inherently skips weekends/holidays, so
// baseline/new dates are always genuine trading days.
export interface EarningsReaction {
  baselineDate: string;
  baselinePrice: number;
  newDate: string;
  newPrice: number;
  reactionPercent: number;
  basis: "post-market" | "pre-market"; // which of the two documented rules produced this
}

export interface EarningsResult {
  status: EarningsFigureStatus;
  reportedDate?: string;   // actual confirmed report date (provider's own date, may differ from expected)
  reportedTiming?: EarningsTimingExpectation;
  actualEps?: number;
  expectedEpsAtReport?: number;    // consensus estimate as carried by the results provider itself
  epsSurprisePct?: number | null;  // null = not computable (one side missing), even if status is "available"
  actualRevenue?: number;
  expectedRevenueAtReport?: number;
  revenueSurprisePct?: number | null;
  // null = figures are in but the reaction isn't computable yet (e.g. the
  // next regular session hasn't closed) – a normal transient state.
  reaction?: EarningsReaction | null;
  interpretation?: string; // deterministic, English badge-style text, from real numbers only – see earningsReaction.ts
  checkedAt: string; // ISO – when this result was last fetched/refreshed
}

// ===== Earnings follow-up (rendered section – recently reported companies
// that were previously tracked via the Upcoming Earnings Calendar) =====

// Same tri-state reasoning as EarningsCalendarStatus/MarketCatalystStatus –
// "no recent reports" and "couldn't verify" must never render the same
// message.
export type EarningsFollowUpStatus = "confirmed" | "noneFound" | "unavailable";

export interface EarningsFollowUpEntry {
  ticker: string;
  name: string;
  reportDate: string;    // actual reported date when known, else the tracked expected date
  daysAgo: number;       // 0 = today
  timeOfDay?: "pre-market" | "post-market";
  result: EarningsResult;
}

// Section-8 diagnostics – see src/reportQuality.ts / src/reportHealth.ts.
// Missing results reduce coverage but must never crash the report.
export interface EarningsFollowUpCoverage {
  tracked: number;             // total tracker records currently held (any status)
  awaiting: number;            // expected date not yet reached, or reached but not yet confirmed reported
  resultsFound: number;        // status === "reported" with actual figures available
  resultsUnavailable: number;  // expected date has passed but the provider has nothing (genuinely unavailable)
  reactionsCalculated: number; // of resultsFound, how many also got a computed price reaction
}

export interface EarningsFollowUpResult {
  entries: EarningsFollowUpEntry[];
  status: EarningsFollowUpStatus;
  coverage: EarningsFollowUpCoverage;
}

// ===== Dividend information (derived from already-fetched company profiles –
// no extra API calls) =====

export interface DividendInfoItem {
  ticker: string;
  name: string;
  dividendPerShare: number;
  dividendYieldPct: number | null;
  exDividendDate?: string;
  dividendDate?: string;
}

// Same tri-state reasoning as EarningsCalendarStatus – "confirmed no
// dividend-paying names" and "couldn't verify (every profile fetch failed)"
// must never render the same "no dividends" message.
export type DividendsStatus = "confirmed" | "unavailable";

// ===== Week ahead =====

export interface WeekAhead {
  earnings: EarningsCalendarEntry[]; // within next 7 days
  earningsStatus: EarningsCalendarStatus;
  economicReadings: EconomicReading[]; // only readings with an actual value
  economicUnavailableCount: number;    // how many series were suppressed (no value)
  // Explicit, never fabricated: things we cannot source live. A single
  // concise notice – never a long list of per-field "Unavailable" lines.
  unavailableNoticeHebrew: string;
}

// ===== Top Opportunities – structured, non-generic thesis (Priority 5) =====
// Every field is built from THIS stock's own real numbers (price/news
// headline, P/E, margin, market cap, a real earnings-calendar lookup, a real
// risk trigger) so two different stocks cannot produce the same text.
export interface OpportunityThesis {
  whyToday: string;        // today's real move/news driver
  whatChanged: string;     // most relevant recent (non-promotional) headline
  keyMetric: string;       // concrete valuation/operating numbers (P/E, margin, cap)
  catalyst: string;        // real upcoming-earnings lookup, or "Unavailable"
  mainRisk: string;        // top real risk trigger
  invalidation: string;    // what would break the thesis, tied to the same real numbers
}

// ===== Technical Watch (Priority 3 + report restructure) =====
// One row per tracked stock – price, local RSI/Bollinger status, computed
// entirely from Yahoo daily closes, never from Alpha Vantage.
export interface TechnicalWatchItem {
  ticker: string;
  name: string;
  price: number;
  changePercent: number;
  // true when `price` came from the historical daily-close series used for
  // RSI/Bollinger (Yahoo), because no live/cached quote was available – the
  // row must show "Last close" rather than an unlabeled (and implicitly
  // wrong) daily change. See src/technicalAlerts.ts / src/pipeline.ts.
  isLastClose: boolean;
  rsi14: number | null;
  statusHebrew: string; // e.g. "מעל הרצועה העליונה", "ניטרלי", "לא זמין"
}

// Everything the report renderers need, already filtered & categorized.
export interface ReportData {
  // Single shared "generated at" timestamp for the entire run (ISO string).
  // Every renderer (Markdown, HTML, HTML email, text email) MUST derive its
  // displayed date/time from this field – never call `new Date()`
  // independently, or two outputs of the same run can show different
  // timestamps despite being "the same report".
  generatedAt: string;
  marketStory: MarketStory | null; // null when no meaningful recent news exists
  additionalHeadlines: MarketStory[]; // up to 2 more relevant (non-promotional) stories
  core: EnrichedStock[];
  growth: EnrichedStock[];
  speculative: EnrichedStock[]; // max 1
  topOpportunities: EnrichedStock[];   // 0-3 – quality-gated, ranked across tiers. NEVER contains an emergency-promoted stock.
  // 0-3 reduced-confidence candidates, populated ONLY when topOpportunities
  // is empty – rendered in their own "⚠️ Reduced-Confidence Watch" block,
  // never inside Top Opportunities. See src/emergencyMode.ts.
  emergencyWatch: EnrichedStock[];
  // true iff emergencyWatch is non-empty (Emergency Report Mode engaged).
  topOpportunitiesEmergencyMode: boolean;
  opportunityTheses: Map<string, OpportunityThesis>; // ticker -> structured thesis, keyed by ticker for BOTH arrays above
  watchlist: EnrichedStock[];   // fixed list, in WATCHLIST order
  technicalWatch: TechnicalWatchItem[];
  technicalAlerts: TechnicalAlerts;
  status: RunStatus;
  scanned: number;   // total raw movers scanned from Alpha Vantage
  qualified: number; // candidates that passed the long-term filter
  fearGreed: FearGreed | null; // null when CNN data is unavailable
  earningsCalendar: EarningsCalendarEntry[];   // next 14 days, prioritized
  earningsCalendarStatus: EarningsCalendarStatus;
  marketCatalyst: MarketCatalystResult;
  marketOverview: MarketOverviewItem[];
  earningsFollowUp: EarningsFollowUpResult;
  dividends: DividendInfoItem[];
  dividendsStatus: DividendsStatus;
  weekAhead: WeekAhead;
  // 0-100 Report Quality Score computed just before rendering – see
  // src/reportQuality.ts. `belowSendThreshold` is true when the score stayed
  // under SEND_THRESHOLD even after the recovery pass, in which case every
  // renderer replaces the normal newsletter with a short diagnostic report
  // rather than sending something misleading or near-empty.
  reportQuality: ReportQuality;
  belowSendThreshold: boolean;
}

export interface RunStatus {
  movers: SourceInfo;
  enriched: SourceInfo; // overall status of enrichment phase
  rateLimitHit: boolean;
  notes: string[];
  // Per-call breakdown across the entire run (movers + all enrichment calls)
  liveCount: number;
  cachedCount: number;
  missingCount: number;
}
