// Pure technical-indicator math (no I/O). Operates on a chronological array of
// daily closing prices (oldest first, newest last).

export interface BollingerBands {
  middle: number; // 20-day simple moving average
  upper: number;  // middle + 2σ
  lower: number;  // middle − 2σ
}

export interface Technicals {
  price: number; // latest close
  bands: BollingerBands;
  rsi14: number;
}

// Simple moving average of the last `period` values.
function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  const sum = slice.reduce((acc, v) => acc + v, 0);
  return sum / slice.length;
}

// Population standard deviation of the last `period` values around their mean.
function stdDev(values: number[], period: number, mean: number): number {
  const slice = values.slice(-period);
  const variance =
    slice.reduce((acc, v) => acc + (v - mean) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

// Bollinger Bands: 20-day SMA ± (multiplier × population σ). Returns null when
// there isn't enough history.
export function bollingerBands(
  closes: number[],
  period = 20,
  multiplier = 2
): BollingerBands | null {
  if (closes.length < period) return null;
  const middle = sma(closes, period);
  const sd = stdDev(closes, period, middle);
  return {
    middle,
    upper: middle + multiplier * sd,
    lower: middle - multiplier * sd,
  };
}

// RSI(14) using Wilder's smoothing. Returns null when there isn't enough history.
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  // Seed: average gain/loss over the first `period` changes.
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smoothing over the remaining changes.
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Combined indicators from a close series. Null if either indicator can't be
// computed (insufficient history).
export function computeTechnicals(closes: number[]): Technicals | null {
  const bands = bollingerBands(closes);
  const r = rsi(closes);
  if (!bands || r === null || closes.length === 0) return null;
  return { price: closes[closes.length - 1], bands, rsi14: r };
}

// RSI interpretation buckets (English label + short Hebrew note).
export function rsiInterpretation(rsiValue: number): {
  label: string;
  hebrew: string;
} {
  if (rsiValue > 70) return { label: "Overbought", hebrew: "קניית יתר" };
  if (rsiValue >= 60) return { label: "Strong Momentum", hebrew: "מומנטום חזק" };
  if (rsiValue >= 40) return { label: "Neutral", hebrew: "ניטרלי" };
  if (rsiValue >= 30) return { label: "Weak", hebrew: "חולשה" };
  return { label: "Oversold", hebrew: "מכירת יתר" };
}
