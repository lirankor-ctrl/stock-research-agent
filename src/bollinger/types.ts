import { NewsItem, SourceInfo } from "../types";

// ===== Bollinger Opportunity of the Day – shared types =====

// One daily session. Prices are ADJUSTED (split + dividend) so that every
// indicator in the series is computed on one consistent price basis – see
// data.ts for exactly how the adjustment factor is applied to O/H/L.
export interface DailyBar {
  date: string; // YYYY-MM-DD, US/Eastern trading date
  open: number;
  high: number;
  low: number;
  close: number;
  rawClose: number; // unadjusted close as actually printed that day
  volume: number;
}

export type AdjustmentBasis = "split+dividend" | "split-only";

export interface PriceSeries {
  symbol: string;
  name?: string;
  exchange?: string;      // Yahoo exchange code (NMS, NYQ, ...)
  instrumentType?: string; // EQUITY / ETF / ...
  currency?: string;
  bars: DailyBar[];       // oldest first, completed sessions only
  adjustment: AdjustmentBasis;
  // Latest quote from the same payload – displayed with its own timestamp,
  // never used inside the indicator math.
  quote: { price: number; timeIso: string } | null;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
}

// Indicator values as of ONE session, computed only from that session and
// earlier ones (no look-ahead).
export interface IndicatorSnapshot {
  date: string;
  close: number;
  high: number;
  low: number;
  sma20: number;
  upper: number;
  lower: number;
  bandwidth: number;      // (upper − lower) / sma20
  percentB: number;       // (close − lower) / (upper − lower)
  bandwidthPercentile: number | null; // 0..100 vs this stock's own history
  bandwidthHistory: number;           // observations behind the percentile
  rsi14: number | null;
  relVolume: number | null; // volume / avg volume of the PRIOR 20 sessions
  avgVolume20: number | null;
  avgDollarVolume20: number | null;
  ma50: number | null;
  ma200: number | null;
  atr14: number | null;
}

export type SetupType = "squeeze" | "breakout" | "meanReversion";
export type SignalStatus = "confirmed" | "emerging";

export interface SetupSignal {
  type: SetupType;
  status: SignalStatus;
  // Short machine-readable evidence list (English), rendered in diagnostics.
  evidence: string[];
  // 0..1 setup-specific quality, feeds the signal component of the score.
  quality: number;
}

export interface ScoreComponent {
  key: "signal" | "trend" | "volume" | "liquidity" | "momentum" | "newsRisk" | "freshness";
  label: string;
  points: number;
  max: number;
  note: string;
}

export interface ScorePenalty {
  key: string;
  points: number; // positive number that is SUBTRACTED
  note: string;
}

export interface OpportunityScore {
  total: number; // 0..100
  components: ScoreComponent[];
  penalties: ScorePenalty[];
}

export interface BollingerCandidate {
  symbol: string;
  name: string;
  series: PriceSeries;
  snapshot: IndicatorSnapshot;
  history: IndicatorSnapshot[]; // last few sessions, oldest first, ending at snapshot
  signal: SetupSignal;
  score: OpportunityScore;
  enriched: boolean; // true once profile/news/earnings were looked up
}

export interface TechnicalPlan {
  entryTrigger: number;
  entryTriggerHebrew: string;
  stopReference: number;
  stopHebrew: string;
  target: number | null;
  targetHebrew: string;
  riskReward: number | null; // null when the levels don't support an honest estimate
  supports: number[];
  resistances: number[];
}

export interface CompanyResearch {
  sector?: string;
  industry?: string;
  description?: string;
  marketCap?: number;
  peRatio?: number;
  eps?: number;
  profitMargin?: number;
  dividendYield?: number;
  profileSource: SourceInfo;
  news: NewsItem[]; // real, provider-sourced, already filtered to the company
  newsSource: SourceInfo;
  nextEarningsDate?: string;
  nextEarningsTiming?: "pre-market" | "post-market";
}

export interface BollingerPick {
  candidate: BollingerCandidate;
  research: CompanyResearch;
  plan: TechnicalPlan;
  signalExplanationHebrew: string;
  trendHebrew: string;
  bullishHebrew: string;
  bearishHebrew: string;
  risksHebrew: string[];
  catalystsHebrew: string[];
  repeatNoteHebrew?: string;
}

export interface RadarItem {
  symbol: string;
  name: string;
  type: SetupType;
  status: SignalStatus;
  score: number;
  close: number;
  percentB: number;
  rsi14: number | null;
}

export interface BollingerScanStats {
  universe: number;
  fetched: number;
  stale: number;
  insufficientHistory: number;
  excluded: number; // OTC / non-equity / illiquid / penny
  analysed: number;
  setupsFound: number;
  confirmed: number;
  expectedSession: string | null; // last completed US session the scan targets
  adjustment: string;
}

export interface BollingerLastPick {
  ticker: string;
  tradingDate: string;
  setupType: SetupType;
  status: SignalStatus;
}

export type BollingerStatus = "selected" | "none" | "unavailable";

export interface BollingerReport {
  status: BollingerStatus;
  pick: BollingerPick | null;
  radar: RadarItem[];
  stats: BollingerScanStats;
  minScore: number;
  noneReasonHebrew?: string;
}

export const EMPTY_BOLLINGER_REPORT: BollingerReport = {
  status: "unavailable",
  pick: null,
  radar: [],
  stats: {
    universe: 0,
    fetched: 0,
    stale: 0,
    insufficientHistory: 0,
    excluded: 0,
    analysed: 0,
    setupsFound: 0,
    confirmed: 0,
    expectedSession: null,
    adjustment: "n/a",
  },
  minScore: 0,
};
