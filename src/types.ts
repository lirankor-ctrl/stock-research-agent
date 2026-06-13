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
// - "available":   the data was fetched and the field is populated.
// - "missing":     we HAVE the data source but the value is genuinely absent
//                  (e.g. the API returned a profile with no market cap).
// - "rateLimited": we could NOT fetch the data (budget / API rate limit). This
//                  is an availability issue, NOT a data-quality issue – it does
//                  not lower the score; it's reported separately.
export type DimensionStatus = "available" | "missing" | "rateLimited";

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
  score: number;             // 0..100 – computed ONLY over assessable dimensions
  label: DataQualityLabel;
  excluded: boolean;         // true only when data is GENUINELY missing
  missing: string[];         // Hebrew – genuinely missing dimensions (lower the score)
  rateLimited: string[];     // Hebrew – unavailable due to rate limit (do NOT lower the score)
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

export interface TechnicalAlerts {
  aboveUpper: TechnicalAlert[]; // price above the upper band (possibly overbought)
  belowLower: TechnicalAlert[]; // price below the lower band (possibly oversold)
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

// Everything the report renderers need, already filtered & categorized.
export interface ReportData {
  marketStory: MarketStory | null; // null when no meaningful recent news exists
  core: EnrichedStock[];
  growth: EnrichedStock[];
  speculative: EnrichedStock[]; // max 1
  topOpportunities: EnrichedStock[];   // max 3 – quality-gated, ranked across tiers
  watchlistHighlights: EnrichedStock[]; // max 5 – best of the watchlist
  watchlist: EnrichedStock[];   // fixed list, in WATCHLIST order
  technicalAlerts: TechnicalAlerts;
  status: RunStatus;
  scanned: number;   // total raw movers scanned from Alpha Vantage
  qualified: number; // candidates that passed the long-term filter
  fearGreed: FearGreed | null; // null when CNN data is unavailable
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
