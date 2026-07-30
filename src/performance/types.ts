// Performance-tracking contract. Shared in spirit with israel-stock-agent so the
// Investment Committee can consume both agents uniformly. Pure data types only.

export type Market = "US" | "IL";
export type RecAction = "accumulate" | "watch" | "avoid";
export type Outcome = "win" | "loss" | "flat";
export type Freshness = "live" | "degraded" | "stale";

// What an agent produces for a single name on a given run.
export interface RecInput {
  symbol: string;
  name?: string;
  score: number; // 1..10 quality/opportunity score
  confidence: number; // 0..1 – DATA-AWARE probability the call works out
  entryPrice: number; // price at the moment of recommendation
  dataQuality: number; // 0..100 – stock-level data completeness
  action: RecAction;
  horizonDays: number; // evaluation horizon for realized return

  // Attribution dimensions – recorded at recommendation time so we can later
  // explain WHY recommendations worked, not just whether they did.
  sector?: string; // industry/sector (or a TASE watchlist proxy)
  marketCap?: number; // in the listing currency; undefined when not fetched
}

// A recommendation tracked through its lifecycle in the ledger.
export interface RecommendationRecord extends RecInput {
  id: string; // `${market}:${symbol}@${recommendedAt-date}`
  market: Market;
  recommendedAt: string; // ISO timestamp
  targetDate: string; // ISO date when the horizon elapses
  status: "open" | "closed";

  // Mark-to-market (updated every run while open):
  lastPrice?: number;
  lastObservedAt?: string;
  returnPct?: number;

  // Realized (set once when closed at/after the horizon):
  closedAt?: string;
  realizedReturnPct?: number;
  outcome?: Outcome;
}

export interface CalibrationBucket {
  label: string; // e.g. "0.70–0.85"
  lo: number;
  hi: number;
  count: number;
  avgConfidence: number; // predicted win probability for the bucket
  winRate: number; // observed win rate in the bucket
  gap: number; // |predicted − observed|
}

// The agent's self-evaluation snapshot for one run.
export interface Metrics {
  market: Market;
  generatedAt: string;

  // Realized performance over CLOSED positions (the real feedback loop):
  closedCount: number;
  winRate: number | null; // wins / closed
  accuracy: number | null; // wins / (wins + losses) – directional hit-rate
  avgReturnPct: number | null;
  medianReturnPct: number | null;

  // Open positions (mark-to-market, not yet realized):
  openCount: number;
  avgOpenReturnPct: number | null;

  // Confidence calibration over closed positions:
  brierScore: number | null; // lower is better (0 perfect, 0.25 = coin flip)
  calibrationError: number | null; // weighted mean |predicted − observed|
  calibration: CalibrationBucket[];

  // Quality of THIS run (honest, freshness-aware – not the old "100 on cache"):
  runDataQuality: number; // 0..100
  freshness: Freshness;

  // Quality of THIS run's emitted recommendations:
  recommendationsThisRun: number;
  reportQualityScore: number; // 0..100 – field completeness of recs
  actionabilityScore: number; // 0..100 – share that are sizeable as-is
  avgConfidence: number | null;
}

// One line appended to runs.jsonl per run – the trend over time.
export interface RunSnapshot {
  generatedAt: string;
  market: Market;
  runDataQuality: number;
  freshness: Freshness;
  recommendationsThisRun: number;
  openCount: number;
  closedCount: number;
  winRate: number | null;
  avgReturnPct: number | null;
  calibrationError: number | null;
  avgConfidence: number | null;
}
