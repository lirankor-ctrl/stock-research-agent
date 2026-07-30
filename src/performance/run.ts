// Orchestrates one run of the feedback loop and persists everything.
// Confidence is computed by the caller (it needs the run data-quality first),
// so this function takes already-built RecInput[] and the run quality verdict.

import { Freshness, Market, Metrics, RecInput, RecommendationRecord } from "./types";
import { computeMetrics, evaluateLedger, recordRecommendations } from "./tracker";
import { appendRunSnapshot, loadLedger, saveLedger, saveMetrics } from "./store";

export interface TrackingResult {
  metrics: Metrics;
  ledger: RecommendationRecord[];
}

export function runTracking(params: {
  reportsDir: string;
  market: Market;
  nowIso: string;
  recs: RecInput[];
  prices: Record<string, number>; // every symbol we have a fresh price for this run
  runDataQuality: number;
  freshness: Freshness;
}): TrackingResult {
  const { reportsDir, market, nowIso, recs, prices, runDataQuality, freshness } = params;

  // 1. Load memory, 2. mark/close prior positions, 3. record new ones.
  let ledger = loadLedger(reportsDir);
  ledger = evaluateLedger(ledger, prices, nowIso);
  ledger = recordRecommendations(ledger, market, recs, nowIso);
  saveLedger(reportsDir, ledger);

  // 4. Self-evaluate.
  const metrics = computeMetrics({
    market,
    nowIso,
    ledger,
    recsThisRun: recs,
    runDataQuality,
    freshness,
  });
  saveMetrics(reportsDir, metrics);

  // 5. Append a trend snapshot.
  appendRunSnapshot(reportsDir, {
    generatedAt: nowIso,
    market,
    runDataQuality: metrics.runDataQuality,
    freshness: metrics.freshness,
    recommendationsThisRun: metrics.recommendationsThisRun,
    openCount: metrics.openCount,
    closedCount: metrics.closedCount,
    winRate: metrics.winRate,
    avgReturnPct: metrics.avgReturnPct,
    calibrationError: metrics.calibrationError,
    avgConfidence: metrics.avgConfidence,
  });

  return { metrics, ledger };
}
