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
  estimatedRevenue?: undefined; // not provided by this free source – always Unavailable
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

// ===== Earnings follow-up (past reports, price reaction) =====

// Same tri-state reasoning as EarningsCalendarStatus/MarketCatalystStatus –
// "no recent reports" and "couldn't verify" must never render the same
// message.
export type EarningsFollowUpStatus = "confirmed" | "noneFound" | "unavailable";

export interface EarningsFollowUpEntry {
  ticker: string;
  name: string;
  reportDate: string;    // YYYY-MM-DD, from Nasdaq's public earnings calendar
  daysAgo: number;       // 0 = today
  timeOfDay?: "pre-market" | "post-market";
  // Approximate cumulative price move since the report date, computed from
  // locally-held Yahoo daily closes (trading-day offset, not calendar days).
  // null when we don't have enough price history to compute it.
  priceChangeSincePct: number | null;
}

export interface EarningsFollowUpResult {
  entries: EarningsFollowUpEntry[];
  status: EarningsFollowUpStatus;
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
  rsi14: number | null;
  statusHebrew: string; // e.g. "מעל הרצועה העליונה", "ניטרלי", "לא זמין"
}

// Everything the report renderers need, already filtered & categorized.
export interface ReportData {
  marketStory: MarketStory | null; // null when no meaningful recent news exists
  additionalHeadlines: MarketStory[]; // up to 2 more relevant (non-promotional) stories
  core: EnrichedStock[];
  growth: EnrichedStock[];
  speculative: EnrichedStock[]; // max 1
  topOpportunities: EnrichedStock[];   // max 3 – quality-gated, ranked across tiers
  opportunityTheses: Map<string, OpportunityThesis>; // ticker -> structured thesis
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
  weekAhead: WeekAhead;
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
