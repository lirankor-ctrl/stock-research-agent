import { DatedClose } from "./marketData";
import { EarningsFigureStatus, EarningsReaction, EarningsTimingExpectation } from "./types";

// ===== Stock reaction to an earnings report =====
//
// Rules (as specified – never substitute one for the other):
//   - POST-MARKET report: baseline = earnings-day regular-session close,
//     new = NEXT regular-session close.
//   - PRE-MARKET report: baseline = PREVIOUS trading-day regular-session
//     close, new = earnings-day regular-session close.
//   - UNKNOWN timing: never guessed – returns null rather than silently
//     assuming a basis (this codebase never invents missing data).
//
// "Actual trading days, weekends/holidays handled correctly" comes for free
// here: `closes` is Yahoo's real daily-close series, which by construction
// contains ONLY days the market actually traded – there is no separate
// holiday calendar to get wrong. Stepping one index before/after the
// earnings-day entry is always a genuine adjacent trading day (e.g. an
// after-market report on a Friday correctly resolves its "next session" to
// the following Monday's entry, because Saturday/Sunday were never in the
// array to begin with).
export function computeEarningsReaction(
  closes: DatedClose[] | null | undefined,
  earningsDateIso: string,
  timing: EarningsTimingExpectation
): EarningsReaction | null {
  if (timing === "unknown") return null;
  if (!closes || closes.length < 2) return null;

  const sorted = dedupeSortedAscending(closes);

  // The earnings-day trading reference: the first REAL trading day on or
  // after the nominal earnings date. Handles both a nominal date that itself
  // fell on a weekend/holiday, and the results provider's actual reported
  // date drifting a day from what was originally expected.
  const earningsIdx = sorted.findIndex((c) => c.date >= earningsDateIso);
  if (earningsIdx === -1) return null; // no trading day on/after this date in our history yet

  if (timing === "post-market") {
    const nextIdx = earningsIdx + 1;
    if (nextIdx >= sorted.length) return null; // next session hasn't closed yet – not computable today
    return toReaction(sorted[earningsIdx], sorted[nextIdx], "post-market");
  }

  // pre-market
  const prevIdx = earningsIdx - 1;
  if (prevIdx < 0) return null; // no prior trading day in our history
  return toReaction(sorted[prevIdx], sorted[earningsIdx], "pre-market");
}

function toReaction(baseline: DatedClose, next: DatedClose, basis: "post-market" | "pre-market"): EarningsReaction | null {
  if (!(baseline.close > 0)) return null;
  return {
    baselineDate: baseline.date,
    baselinePrice: baseline.close,
    newDate: next.date,
    newPrice: next.close,
    reactionPercent: Math.round(((next.close - baseline.close) / baseline.close) * 1000) / 10,
    basis,
  };
}

function dedupeSortedAscending(closes: DatedClose[]): DatedClose[] {
  const sorted = [...closes].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const seen = new Set<string>();
  const out: DatedClose[] = [];
  for (const c of sorted) {
    if (seen.has(c.date)) continue;
    seen.add(c.date);
    out.push(c);
  }
  return out;
}

// ===== Beat/miss classification =====

export type BeatMissLabel = "beat" | "miss" | "inline" | "unavailable";

// A tiny in-line tolerance keeps a penny-level rounding difference from
// reading as a "miss" – 0.5% either side of consensus counts as in-line.
const INLINE_TOLERANCE_PCT = 0.5;

export function classifyBeatMiss(surprisePct: number | null | undefined): BeatMissLabel {
  if (surprisePct === null || surprisePct === undefined) return "unavailable";
  if (surprisePct > INLINE_TOLERANCE_PCT) return "beat";
  if (surprisePct < -INLINE_TOLERANCE_PCT) return "miss";
  return "inline";
}

export function computeSurprisePct(actual: number | undefined, expected: number | undefined): number | null {
  if (actual === undefined || expected === undefined || expected === 0) return null;
  return Math.round(((actual - expected) / Math.abs(expected)) * 1000) / 10;
}

// ===== Deterministic interpretation =====
//
// Built ONLY from the real numbers already computed above – never a
// speculative explanation. Short, English badge-style text, matching this
// report's existing convention of literal English labels for compact
// verdict badges even inside an otherwise Hebrew newsletter (e.g.
// EMERGENCY_MODE_LABEL, FALLBACK_NOTICE). When a required input is missing,
// the sentence says so explicitly rather than guessing.
export function buildInterpretation(input: {
  epsStatus: EarningsFigureStatus;
  epsSurprisePct: number | null | undefined;
  revenueStatus: EarningsFigureStatus;
  revenueSurprisePct: number | null | undefined;
  reaction: EarningsReaction | null | undefined;
}): string {
  const { epsStatus, epsSurprisePct, revenueStatus, revenueSurprisePct, reaction } = input;

  if (epsStatus !== "available" && revenueStatus !== "available") {
    return "No actual EPS or revenue figures yet — result cannot be assessed.";
  }

  const epsLabel = classifyBeatMiss(epsSurprisePct);
  const revenueLabel = classifyBeatMiss(revenueSurprisePct);
  const bothBeat = epsLabel === "beat" && revenueLabel === "beat";
  const bothMiss = epsLabel === "miss" && revenueLabel === "miss";

  if (!reaction) {
    if (bothBeat) return "Results beat estimates; stock reaction not yet available.";
    if (bothMiss) return "Results missed estimates; stock reaction not yet available.";
    return "Mixed earnings result; stock reaction not yet available.";
  }

  const positiveReaction = reaction.reactionPercent > 0;
  const negativeReaction = reaction.reactionPercent < 0;

  if (bothBeat && positiveReaction) return "Strong report with positive market confirmation.";
  if (bothBeat && negativeReaction) {
    return "Results beat estimates, but the stock fell — expectations may have been higher.";
  }
  if (bothMiss && negativeReaction) return "Weak report confirmed by negative market reaction.";
  if (bothMiss && positiveReaction) {
    return "Results missed estimates, but the stock rose — the reaction may be pricing in other factors.";
  }
  return "Mixed earnings result; market reaction provides the stronger signal.";
}
