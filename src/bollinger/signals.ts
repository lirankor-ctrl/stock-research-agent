// Setup detection on the latest completed session (long-side only).
//
// Each setup has an explicit EMERGING state (watch, not a signal) and a
// CONFIRMED state (all confirmation rules met). Only confirmed setups can
// become the Opportunity of the Day. Touching or closing below the lower band
// is never by itself a buy signal – it is at most an emerging mean-reversion
// setup until a recovery is confirmed.
import { IndicatorSnapshot, SetupSignal } from "./types";

export const SQUEEZE_PERCENTILE = 20;     // bandwidth in the lowest 20% of its own year
export const BREAKOUT_REL_VOLUME = 1.5;   // breakout needs ≥ 1.5× average volume
export const REVERSAL_REL_VOLUME = 1.0;   // recovery day at least average volume
export const OVERSOLD_RSI = 35;
export const SIGNAL_LOOKBACK = 5;         // sessions a squeeze/touch "counts" for

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const fmt = (n: number | null, d = 2) => (n === null ? "n/a" : n.toFixed(d));

function inSqueeze(s: IndicatorSnapshot): boolean {
  return s.bandwidthPercentile !== null && s.bandwidthPercentile <= SQUEEZE_PERCENTILE;
}

function trendUp(s: IndicatorSnapshot): boolean {
  return s.ma50 !== null && s.close > s.ma50 && (s.ma200 === null || s.close > s.ma200);
}

// `history` = consecutive snapshots ending at the evaluated session.
export function detectSqueeze(history: IndicatorSnapshot[]): SetupSignal | null {
  const t = history[history.length - 1];
  const prior = history.slice(-1 - SIGNAL_LOOKBACK, -1);
  const squeezedBefore = prior.filter(inSqueeze);
  const minPct = Math.min(...[...prior, t].map((s) => s.bandwidthPercentile ?? 100));

  if (squeezedBefore.length > 0 && t.close > t.upper) {
    const volOk = (t.relVolume ?? 0) >= BREAKOUT_REL_VOLUME;
    const evidence = [
      `bandwidth percentile ${fmt(minPct, 0)} within last ${SIGNAL_LOOKBACK} sessions`,
      `close ${fmt(t.close)} > upper band ${fmt(t.upper)}`,
      `relative volume ${fmt(t.relVolume)}×`,
    ];
    if (volOk && trendUp(t)) {
      return { type: "squeeze", status: "confirmed", evidence, quality: clamp01(1 - minPct / SQUEEZE_PERCENTILE) };
    }
    return {
      type: "squeeze",
      status: "emerging",
      evidence: [...evidence, volOk ? "trend (MA50/MA200) not aligned" : "volume confirmation missing"],
      quality: 0.3,
    };
  }

  if (inSqueeze(t) && t.close <= t.upper && t.close >= t.lower) {
    return {
      type: "squeeze",
      status: "emerging",
      evidence: [`bandwidth percentile ${fmt(t.bandwidthPercentile, 0)} (narrow)`, `%B ${fmt(t.percentB)} – no breakout yet`],
      quality: clamp01((1 - (t.bandwidthPercentile ?? SQUEEZE_PERCENTILE) / SQUEEZE_PERCENTILE) * (t.percentB > 0.5 ? 1 : 0.5)),
    };
  }
  return null;
}

export function detectBreakout(history: IndicatorSnapshot[]): SetupSignal | null {
  const t = history[history.length - 1];
  const p = history[history.length - 2];
  if (!p) return null;

  if (t.close > t.upper && t.close > p.close) {
    const volOk = (t.relVolume ?? 0) >= BREAKOUT_REL_VOLUME;
    const evidence = [
      `close ${fmt(t.close)} > upper band ${fmt(t.upper)} (%B ${fmt(t.percentB)})`,
      `relative volume ${fmt(t.relVolume)}×`,
      `MA50 ${fmt(t.ma50)} · MA200 ${fmt(t.ma200)}`,
    ];
    // Ideal breakout closes modestly outside the band; far outside = chasing.
    const quality = t.percentB <= 1.1 ? 1 : t.percentB <= 1.2 ? 0.5 : 0.1;
    if (volOk && trendUp(t)) return { type: "breakout", status: "confirmed", evidence, quality };
    return {
      type: "breakout",
      status: "emerging",
      evidence: [...evidence, volOk ? "trend (MA50/MA200) not aligned" : "volume confirmation missing"],
      quality: quality * 0.4,
    };
  }

  const widening = history.length > SIGNAL_LOOKBACK && t.bandwidth > history[history.length - 1 - SIGNAL_LOOKBACK].bandwidth;
  if (t.percentB >= 0.9 && t.percentB <= 1 && widening && trendUp(t)) {
    return {
      type: "breakout",
      status: "emerging",
      evidence: [`%B ${fmt(t.percentB)} pressing the upper band`, "bandwidth expanding", "above MA50"],
      quality: 0.4,
    };
  }
  return null;
}

export function detectMeanReversion(history: IndicatorSnapshot[]): SetupSignal | null {
  const t = history[history.length - 1];
  const p = history[history.length - 2];
  if (!p) return null;
  const prior = history.slice(-1 - SIGNAL_LOOKBACK, -1);
  const touchedBefore = prior.some((s) => s.close < s.lower || s.low < s.lower);
  const minRsi = Math.min(...[...prior, t].map((s) => s.rsi14 ?? 100));
  const minPctB = Math.min(...prior.map((s) => s.percentB));

  if (touchedBefore && t.close > t.lower) {
    const checks = {
      closesAbovePriorHigh: t.close > p.high,
      percentBRising: t.percentB > p.percentB,
      rsiTurningUp: t.rsi14 !== null && p.rsi14 !== null && t.rsi14 > p.rsi14,
      wasOversold: minRsi <= OVERSOLD_RSI,
      volumeOk: (t.relVolume ?? 0) >= REVERSAL_REL_VOLUME,
    };
    const evidence = [
      `lower band touched within last ${SIGNAL_LOOKBACK} sessions (min %B ${fmt(minPctB)})`,
      `close ${fmt(t.close)} vs prior high ${fmt(p.high)}`,
      `RSI ${fmt(p.rsi14, 1)} → ${fmt(t.rsi14, 1)} (window low ${fmt(minRsi, 1)})`,
      `relative volume ${fmt(t.relVolume)}×`,
    ];
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    const quality = clamp01((t.percentB - minPctB) / 0.5);
    if (failed.length === 0) return { type: "meanReversion", status: "confirmed", evidence, quality };
    return { type: "meanReversion", status: "emerging", evidence: [...evidence, `unconfirmed: ${failed.join(", ")}`], quality: quality * 0.3 };
  }

  // At or below the lower band right now: explicitly NOT a buy signal.
  if (t.percentB <= 0.05) {
    return {
      type: "meanReversion",
      status: "emerging",
      evidence: [`%B ${fmt(t.percentB)} at/below lower band – recovery not yet confirmed`],
      quality: 0.1,
    };
  }
  return null;
}

const SETUP_PRIORITY: Record<SetupSignal["type"], number> = { squeeze: 3, breakout: 2, meanReversion: 1 };

// Best single setup for the session: confirmed beats emerging; then squeeze
// breakout > plain breakout > mean reversion (a squeeze breakout is a
// breakout with the extra evidence of a prior volatility contraction).
export function detectSetup(history: IndicatorSnapshot[]): SetupSignal | null {
  if (history.length < 2) return null;
  const found = [detectSqueeze(history), detectBreakout(history), detectMeanReversion(history)].filter(
    (s): s is SetupSignal => s !== null
  );
  found.sort((a, b) => {
    if (a.status !== b.status) return a.status === "confirmed" ? -1 : 1;
    return SETUP_PRIORITY[b.type] - SETUP_PRIORITY[a.type];
  });
  return found[0] ?? null;
}
