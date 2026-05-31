export type StockCategory = "gainer" | "loser" | "active";

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
  preScore: number;
}

export interface ScoreBreakdown {
  priceMove: number;
  volume: number;
  newsQuality: number;
  companyQuality: number;
  marketCap: number;
  total: number;
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
  score: ScoreBreakdown;
  finalScore: number;
  profileSource: SourceInfo;
  newsSource: SourceInfo;
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
