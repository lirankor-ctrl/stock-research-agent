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

// Everything the report renderers need, already filtered & categorized.
export interface ReportData {
  core: EnrichedStock[];
  growth: EnrichedStock[];
  speculative: EnrichedStock[]; // max 1
  watchlist: EnrichedStock[];   // fixed list, in WATCHLIST order
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
