// Pure indicator math for the Bollinger engine (no I/O).
//
// Every value at index i is computed ONLY from bars[0..i]. Nothing here ever
// reads a later bar, so a snapshot for session D is exactly what an observer
// could have computed at D's close – the look-ahead self-test asserts this by
// appending future bars and checking earlier snapshots don't change.
import { DailyBar, IndicatorSnapshot } from "./types";

export const BB_PERIOD = 20;
export const BB_MULTIPLIER = 2;
export const RSI_PERIOD = 14;
export const ATR_PERIOD = 14;
export const VOLUME_LOOKBACK = 20;
// Bandwidth percentile looks back ~1 trading year and needs at least ~5
// months of bandwidth history to be meaningful; below that it is null rather
// than a percentile of a handful of points.
export const BW_PERCENTILE_LOOKBACK = 252;
export const BW_PERCENTILE_MIN_HISTORY = 100;

function mean(values: number[]): number {
  return values.reduce((a, v) => a + v, 0) / values.length;
}

// Population σ – the conventional Bollinger definition, and the same one
// src/technicals.ts already uses, so both sections agree on band values.
function populationStd(values: number[], m: number): number {
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / values.length);
}

export function smaAt(values: number[], i: number, period: number): number | null {
  if (i + 1 < period) return null;
  return mean(values.slice(i + 1 - period, i + 1));
}

// RSI with Wilder smoothing, as a full series (null until enough history).
export function rsiSeries(closes: number[], period = RSI_PERIOD): Array<number | null> {
  const out: Array<number | null> = closes.map(() => null);
  if (closes.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(ch, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

// Average True Range with Wilder smoothing.
export function atrSeries(bars: DailyBar[], period = ATR_PERIOD): Array<number | null> {
  const out: Array<number | null> = bars.map(() => null);
  if (bars.length < period + 1) return out;
  const tr = bars.map((b, i) =>
    i === 0
      ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))
  );
  let atr = mean(tr.slice(1, period + 1));
  out[period] = atr;
  for (let i = period + 1; i < bars.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

// Share of the trailing window's observations that are <= the current value.
// The window ends AT i (inclusive) – never after it.
export function percentileRank(series: Array<number | null>, i: number, lookback: number, minHistory: number): {
  pct: number | null;
  count: number;
} {
  const current = series[i];
  if (current === null || current === undefined) return { pct: null, count: 0 };
  const window = series.slice(Math.max(0, i + 1 - lookback), i + 1).filter((v): v is number => v !== null);
  if (window.length < minHistory) return { pct: null, count: window.length };
  const atOrBelow = window.filter((v) => v <= current).length;
  return { pct: (atOrBelow / window.length) * 100, count: window.length };
}

// Snapshot series aligned to `bars`: null where fewer than BB_PERIOD bars exist.
export function computeSnapshots(bars: DailyBar[]): Array<IndicatorSnapshot | null> {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const rsi = rsiSeries(closes);
  const atr = atrSeries(bars);

  const bandwidths: Array<number | null> = bars.map((_, i) => {
    const mid = smaAt(closes, i, BB_PERIOD);
    if (mid === null || mid <= 0) return null;
    const sd = populationStd(closes.slice(i + 1 - BB_PERIOD, i + 1), mid);
    return (2 * BB_MULTIPLIER * sd) / mid;
  });

  return bars.map((bar, i) => {
    const sma20 = smaAt(closes, i, BB_PERIOD);
    if (sma20 === null) return null;
    const sd = populationStd(closes.slice(i + 1 - BB_PERIOD, i + 1), sma20);
    const upper = sma20 + BB_MULTIPLIER * sd;
    const lower = sma20 - BB_MULTIPLIER * sd;
    const width = upper - lower;

    // Relative volume compares today against the PRIOR 20 sessions so
    // today's own spike can't dilute its own baseline.
    const prior = i >= VOLUME_LOOKBACK ? volumes.slice(i - VOLUME_LOOKBACK, i) : null;
    const avgVolume20 = prior && prior.every((v) => v > 0) ? mean(prior) : null;
    const priorDollar =
      i >= VOLUME_LOOKBACK ? bars.slice(i - VOLUME_LOOKBACK, i).map((b) => b.rawClose * b.volume) : null;
    const pr = percentileRank(bandwidths, i, BW_PERCENTILE_LOOKBACK, BW_PERCENTILE_MIN_HISTORY);

    return {
      date: bar.date,
      close: bar.close,
      high: bar.high,
      low: bar.low,
      sma20,
      upper,
      lower,
      bandwidth: bandwidths[i] as number,
      percentB: width > 0 ? (bar.close - lower) / width : 0.5,
      bandwidthPercentile: pr.pct,
      bandwidthHistory: pr.count,
      rsi14: rsi[i],
      relVolume: avgVolume20 && avgVolume20 > 0 ? bar.volume / avgVolume20 : null,
      avgVolume20,
      avgDollarVolume20: priorDollar ? mean(priorDollar) : null,
      ma50: smaAt(closes, i, 50),
      ma200: smaAt(closes, i, 200),
      atr14: atr[i],
    };
  });
}
