// Pure, side-effect-free performance logic. Shared verbatim with
// israel-stock-agent. All IO lives in store.ts; all wiring in the pipeline.
//
// The feedback loop:
//   record(recs)  ->  evaluate(prices) every later run  ->  close at horizon
//   ->  metrics() turns the closed history into KPIs + calibration.

import {
  CalibrationBucket,
  Freshness,
  Market,
  Metrics,
  Outcome,
  RecInput,
  RecommendationRecord,
} from "./types";

// A realized move smaller than this (in %) is a draw, not a win or a loss.
const FLAT_DEADBAND_PCT = 0.5;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function isoDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function makeId(market: Market, symbol: string, recommendedAtIso: string): string {
  return `${market}:${symbol}@${isoDateOnly(recommendedAtIso)}`;
}

function classifyOutcome(returnPct: number): Outcome {
  if (returnPct > FLAT_DEADBAND_PCT) return "win";
  if (returnPct < -FLAT_DEADBAND_PCT) return "loss";
  return "flat";
}

// ===== Data-aware confidence =====
// Confidence is meant to be a probability the call works out – so it MUST fall
// when the underlying data is stale, cached, or thin. This is the fix for the
// committee's "100/100 confidence on a fully-cached run" finding.
export function computeConfidence(
  score: number, // 1..10
  stockDataQuality: number, // 0..100
  runDataQuality: number // 0..100
): number {
  const base = clamp((score - 1) / 9, 0, 1); // 1->0, 10->1
  const dataFactor = 0.5 + 0.5 * clamp(stockDataQuality / 100, 0, 1);
  const runFactor = 0.5 + 0.5 * clamp(runDataQuality / 100, 0, 1);
  return clamp(base * dataFactor * runFactor, 0, 0.99);
}

// ===== Honest, freshness-aware run data-quality =====
// live counts full, cached counts half, missing counts zero. A fully-cached run
// therefore scores ~50 (not 100), which is the point.
export function computeRunDataQuality(
  live: number,
  cached: number,
  missing: number
): { score: number; freshness: Freshness } {
  const total = live + cached + missing;
  if (total === 0) return { score: 0, freshness: "stale" };
  const score = Math.round(((live * 1 + cached * 0.5) / total) * 100);
  let freshness: Freshness;
  if (live > 0 && cached === 0 && missing === 0) freshness = "live";
  else if (live === 0) freshness = "stale";
  else freshness = "degraded";
  return { score, freshness };
}

// ===== Evaluate: mark every open position to market; close matured ones =====
export function evaluateLedger(
  ledger: RecommendationRecord[],
  prices: Record<string, number>,
  nowIso: string
): RecommendationRecord[] {
  const now = new Date(nowIso).getTime();
  return ledger.map((rec) => {
    if (rec.status === "closed") return rec;
    const price = prices[rec.symbol];
    const updated: RecommendationRecord = { ...rec };

    if (typeof price === "number" && price > 0 && rec.entryPrice > 0) {
      updated.lastPrice = price;
      updated.lastObservedAt = nowIso;
      updated.returnPct = ((price - rec.entryPrice) / rec.entryPrice) * 100;
    }

    const matured = now >= new Date(rec.targetDate).getTime();
    if (matured && typeof updated.returnPct === "number") {
      updated.status = "closed";
      updated.closedAt = nowIso;
      updated.realizedReturnPct = updated.returnPct;
      updated.outcome = classifyOutcome(updated.returnPct);
    }
    return updated;
  });
}

// ===== Record: add new recs, but never double-open the same symbol =====
export function recordRecommendations(
  ledger: RecommendationRecord[],
  market: Market,
  recs: RecInput[],
  nowIso: string
): RecommendationRecord[] {
  const openSymbols = new Set(
    ledger.filter((r) => r.status === "open").map((r) => r.symbol)
  );
  const additions: RecommendationRecord[] = [];
  for (const rec of recs) {
    if (rec.entryPrice <= 0) continue; // can't track a position without a price
    if (openSymbols.has(rec.symbol)) continue; // already have an open position
    additions.push({
      ...rec,
      id: makeId(market, rec.symbol, nowIso),
      market,
      recommendedAt: nowIso,
      targetDate: addDays(nowIso, rec.horizonDays),
      status: "open",
    });
    openSymbols.add(rec.symbol);
  }
  return [...ledger, ...additions];
}

// ===== Metrics: turn the ledger + this run's recs into KPIs =====
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round(n: number | null, dp = 2): number | null {
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

const BUCKETS: Array<{ label: string; lo: number; hi: number }> = [
  { label: "0.00–0.50", lo: 0, hi: 0.5 },
  { label: "0.50–0.70", lo: 0.5, hi: 0.7 },
  { label: "0.70–0.85", lo: 0.7, hi: 0.85 },
  { label: "0.85–1.00", lo: 0.85, hi: 1.0001 },
];

function buildCalibration(closed: RecommendationRecord[]): CalibrationBucket[] {
  return BUCKETS.map((b) => {
    const inBucket = closed.filter((r) => r.confidence >= b.lo && r.confidence < b.hi);
    const wins = inBucket.filter((r) => r.outcome === "win").length;
    const avgConfidence = mean(inBucket.map((r) => r.confidence)) ?? 0;
    const winRate = inBucket.length ? wins / inBucket.length : 0;
    return {
      label: b.label,
      lo: b.lo,
      hi: b.hi,
      count: inBucket.length,
      avgConfidence: round(avgConfidence, 3)!,
      winRate: round(winRate, 3)!,
      gap: round(Math.abs(avgConfidence - winRate), 3)!,
    };
  });
}

export function computeMetrics(params: {
  market: Market;
  nowIso: string;
  ledger: RecommendationRecord[];
  recsThisRun: RecInput[];
  runDataQuality: number;
  freshness: Freshness;
}): Metrics {
  const { market, nowIso, ledger, recsThisRun, runDataQuality, freshness } = params;

  const closed = ledger.filter((r) => r.status === "closed");
  const open = ledger.filter((r) => r.status === "open");

  const wins = closed.filter((r) => r.outcome === "win").length;
  const losses = closed.filter((r) => r.outcome === "loss").length;
  const realized = closed
    .map((r) => r.realizedReturnPct)
    .filter((x): x is number => typeof x === "number");
  const openReturns = open
    .map((r) => r.returnPct)
    .filter((x): x is number => typeof x === "number");

  // Brier / calibration over closed positions (win = realized > deadband).
  const brier =
    closed.length > 0
      ? mean(
          closed.map((r) => {
            const won = r.outcome === "win" ? 1 : 0;
            return (r.confidence - won) ** 2;
          })
        )
      : null;
  const calibration = buildCalibration(closed);
  const calibrationError =
    closed.length > 0
      ? calibration.reduce((acc, b) => acc + (b.count / closed.length) * b.gap, 0)
      : null;

  // Quality of THIS run's recommendations.
  const required = (r: RecInput) =>
    r.entryPrice > 0 && r.horizonDays > 0 && r.confidence > 0 && !!r.action && r.score > 0;
  const sizeable = (r: RecInput) =>
    r.entryPrice > 0 && r.horizonDays > 0 && r.confidence >= 0.5;
  const reportQualityScore = recsThisRun.length
    ? Math.round((recsThisRun.filter(required).length / recsThisRun.length) * 100)
    : 0;
  const actionabilityScore = recsThisRun.length
    ? Math.round((recsThisRun.filter(sizeable).length / recsThisRun.length) * 100)
    : 0;

  return {
    market,
    generatedAt: nowIso,
    closedCount: closed.length,
    winRate: closed.length ? round(wins / closed.length, 3) : null,
    accuracy: wins + losses > 0 ? round(wins / (wins + losses), 3) : null,
    avgReturnPct: round(mean(realized), 2),
    medianReturnPct: round(median(realized), 2),
    openCount: open.length,
    avgOpenReturnPct: round(mean(openReturns), 2),
    brierScore: round(brier, 4),
    calibrationError: round(calibrationError, 3),
    calibration,
    runDataQuality,
    freshness,
    recommendationsThisRun: recsThisRun.length,
    reportQualityScore,
    actionabilityScore,
    avgConfidence: round(mean(recsThisRun.map((r) => r.confidence)), 3),
  };
}
