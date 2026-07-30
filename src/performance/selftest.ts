// Deterministic proof that the evaluation + calibration engine is correct.
// Uses SYNTHETIC entry/exit prices (clearly not real performance) so the math
// can be verified today, before live positions reach their horizon.
//
//   npm run perf:selftest

import { computeConfidence, computeRunDataQuality, evaluateLedger, recordRecommendations } from "./tracker";
import { computeMetrics } from "./tracker";
import { RecInput } from "./types";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${msg}`);
  }
}

const T0 = "2026-03-17T12:00:00.000Z"; // recommendation day
const T1 = "2026-06-15T12:00:00.000Z"; // ~90 days later (horizon elapsed)

// 1) Honest run data-quality.
const liveDQ = computeRunDataQuality(10, 0, 0);
const cachedDQ = computeRunDataQuality(0, 10, 0);
assert(liveDQ.score === 100 && liveDQ.freshness === "live", "fully-live run scores 100/live");
assert(cachedDQ.score === 50 && cachedDQ.freshness === "stale", "fully-cached run scores 50/stale (NOT 100)");

// 2) Data-aware confidence falls on a cached run.
const confLive = computeConfidence(8.7, 100, 100);
const confCached = computeConfidence(8.7, 100, 50);
assert(confCached < confLive, "confidence is lower on a cached run than a live run");

// 3) Record 4 recs at T0 with known confidences, then close them at T1.
const recs: RecInput[] = [
  { symbol: "AAA", score: 9, confidence: 0.9, entryPrice: 100, dataQuality: 100, action: "accumulate", horizonDays: 90 },
  { symbol: "BBB", score: 8, confidence: 0.8, entryPrice: 200, dataQuality: 100, action: "accumulate", horizonDays: 90 },
  { symbol: "CCC", score: 7, confidence: 0.6, entryPrice: 50, dataQuality: 100, action: "watch", horizonDays: 90 },
  { symbol: "DDD", score: 6, confidence: 0.55, entryPrice: 40, dataQuality: 100, action: "watch", horizonDays: 90 },
];
let ledger = recordRecommendations([], "US", recs, T0);
assert(ledger.length === 4 && ledger.every((r) => r.status === "open"), "4 open positions recorded");

// Synthetic exit prices: AAA +20%, BBB +5% (wins), CCC -10%, DDD -2% (losses).
const exitPrices = { AAA: 120, BBB: 210, CCC: 45, DDD: 39.2 };
ledger = evaluateLedger(ledger, exitPrices, T1);
assert(ledger.every((r) => r.status === "closed"), "all positions closed at horizon");

const aaa = ledger.find((r) => r.symbol === "AAA")!;
assert(Math.abs((aaa.realizedReturnPct ?? 0) - 20) < 1e-9, "AAA realized return = +20%");

const m = computeMetrics({
  market: "US",
  nowIso: T1,
  ledger,
  recsThisRun: recs,
  runDataQuality: 100,
  freshness: "live",
});

assert(m.closedCount === 4, "closedCount = 4");
assert(m.winRate === 0.5, "winRate = 50% (2 wins / 4)");
assert(m.accuracy === 0.5, "accuracy = 50% (2 wins / 4 directional)");
assert(Math.abs((m.avgReturnPct ?? 0) - 3.25) < 1e-9, "avgReturnPct = +3.25%");
assert(m.brierScore !== null, "Brier score computed");
assert(m.calibrationError !== null, "calibration error computed");

console.log("\n--- metrics snapshot (synthetic) ---");
console.log(JSON.stringify(m, null, 2));
console.log(
  process.exitCode ? "\n💥 self-test FAILED" : "\n🎉 performance engine self-test PASSED"
);
