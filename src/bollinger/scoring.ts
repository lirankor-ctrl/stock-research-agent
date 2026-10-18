// Transparent, deterministic 0–100 opportunity score.
//
//   signal     30  setup quality; confirmed base 22, emerging base 6
//   trend      15  close>MA50 (5) · close>MA200 (5) · MA50>MA200 (5)
//   volume     15  relative volume, linear 0.8× → 0 … 2.0× → 15
//   liquidity  10  20-day average dollar volume, log-scaled $20M → $1B
//   momentum   10  RSI(14) in the zone that fits the setup type
//   newsRisk   10  recent material news & binary-event (earnings) risk
//   freshness  10  last bar = expected session (6) · ≥1y history (2) · fundamentals (2)
//
// Penalties are subtracted afterwards: extension/chase, volatility (ATR%),
// counter-trend (below MA200), wide stop, thin or missing risk/reward.
// Missing inputs never earn points – they are not invented.
import { NewsItem } from "../types";
import { isPromotionalOrLegalNews, materiality } from "../newsFilter";
import { IndicatorSnapshot, OpportunityScore, ScoreComponent, ScorePenalty, SetupSignal } from "./types";

// Calibrated on a 60-session no-look-ahead replay (2026-07 → 2026-10): real
// qualifying picks cluster at 72–92; the 65–70 band was mostly stretched
// breakouts (chase risk), so 70 is the high-confidence bar.
export const MIN_SELECTION_SCORE = 70;
export const MIN_DOLLAR_VOLUME = 20_000_000;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

const NEGATIVE_NEWS =
  /\b(lawsuit|sues|sued|probe|investigation|subpoena|SEC charges|fraud|downgrade[sd]?|cuts? (its )?(guidance|outlook|forecast)|lowers? (guidance|outlook|forecast)|recall|bankruptcy|chapter 11|default|secondary offering|share offering|dilution|misses|plunge[sd]?|tumble[sd]?|halt(ed)?|restatement|resign(s|ed)?)\b/i;

export interface NewsRiskInput {
  news: NewsItem[] | null; // null = not looked up / unavailable
  daysToEarnings: number | null;
}

export interface NewsRiskAssessment {
  points: number;
  note: string;
  negativeHeadlines: NewsItem[];
}

export function assessNewsRisk({ news, daysToEarnings }: NewsRiskInput): NewsRiskAssessment {
  let points: number;
  const notes: string[] = [];
  let negativeHeadlines: NewsItem[] = [];
  if (news === null) {
    points = 5;
    notes.push("news unavailable – neutral, not assumed positive");
  } else {
    const relevant = news.filter((n) => !isPromotionalOrLegalNews(n));
    negativeHeadlines = news.filter((n) => NEGATIVE_NEWS.test(n.title ?? ""));
    const material = relevant.filter((n) => materiality(n).weight > 0 && !NEGATIVE_NEWS.test(n.title ?? ""));
    points = 8 + (material.length > 0 ? 2 : 0) - 4 * Math.min(negativeHeadlines.length, 2);
    notes.push(`${relevant.length} recent items · ${material.length} material · ${negativeHeadlines.length} negative`);
  }
  if (daysToEarnings !== null && daysToEarnings >= 0 && daysToEarnings <= 7) {
    points -= 4;
    notes.push(`earnings in ${daysToEarnings}d (binary-event risk)`);
  }
  return { points: clamp(points, 0, 10), note: notes.join(" · "), negativeHeadlines };
}

export interface ScoreInput {
  snapshot: IndicatorSnapshot;
  signal: SetupSignal;
  isFresh: boolean;
  barCount: number;
  hasFundamentals: boolean;
  newsRisk: NewsRiskAssessment | null; // null before the finalist enrichment step
  stopDistancePct?: number | null;       // from the technical plan
  riskReward?: number | null;            // from the technical plan
}

function signalComponent(signal: SetupSignal): ScoreComponent {
  const points = signal.status === "confirmed" ? 22 + 8 * signal.quality : 6 + 4 * signal.quality;
  return { key: "signal", label: "Bollinger signal quality", points: round1(points), max: 30, note: `${signal.type} · ${signal.status}` };
}

function trendComponent(s: IndicatorSnapshot): ScoreComponent {
  let points = 0;
  const parts: string[] = [];
  if (s.ma50 !== null && s.close > s.ma50) { points += 5; parts.push(">MA50"); }
  if (s.ma200 !== null && s.close > s.ma200) { points += 5; parts.push(">MA200"); }
  if (s.ma50 !== null && s.ma200 !== null && s.ma50 > s.ma200) { points += 5; parts.push("MA50>MA200"); }
  if (s.ma200 === null) parts.push("MA200 n/a");
  return { key: "trend", label: "Trend alignment", points, max: 15, note: parts.join(" ") || "below both averages" };
}

function volumeComponent(s: IndicatorSnapshot): ScoreComponent {
  const rv = s.relVolume;
  const points = rv === null ? 0 : clamp(((rv - 0.8) / 1.2) * 15, 0, 15);
  return { key: "volume", label: "Volume confirmation", points: round1(points), max: 15, note: rv === null ? "n/a" : `${rv.toFixed(2)}× avg` };
}

function liquidityComponent(s: IndicatorSnapshot): ScoreComponent {
  const adv = s.avgDollarVolume20;
  const points =
    adv === null || adv < MIN_DOLLAR_VOLUME ? 0 : clamp(3 + (7 * Math.log10(adv / MIN_DOLLAR_VOLUME)) / Math.log10(50), 0, 10);
  return {
    key: "liquidity",
    label: "Liquidity",
    points: round1(points),
    max: 10,
    note: adv === null ? "n/a" : `$${(adv / 1e6).toFixed(0)}M avg daily $-volume`,
  };
}

function momentumComponent(s: IndicatorSnapshot, signal: SetupSignal): ScoreComponent {
  const r = s.rsi14;
  let points = 0;
  if (r !== null) {
    if (signal.type === "meanReversion") points = r >= 35 && r <= 50 ? 10 : r > 50 && r <= 60 ? 6 : 3;
    else points = r >= 55 && r <= 72 ? 10 : (r >= 50 && r < 55) || (r > 72 && r <= 78) ? 6 : 2;
  }
  return { key: "momentum", label: "Momentum (RSI)", points, max: 10, note: r === null ? "RSI n/a" : `RSI ${r.toFixed(1)}` };
}

function freshnessComponent(input: ScoreInput): ScoreComponent {
  const points = (input.isFresh ? 6 : 0) + (input.barCount >= 252 ? 2 : input.barCount >= 200 ? 1 : 0) + (input.hasFundamentals ? 2 : 0);
  const note = `${input.isFresh ? "current session" : "STALE"} · ${input.barCount} bars · fundamentals ${input.hasFundamentals ? "yes" : "no"}`;
  return { key: "freshness", label: "Data freshness & completeness", points, max: 10, note };
}

function penalties(s: IndicatorSnapshot, signal: SetupSignal, input: ScoreInput): ScorePenalty[] {
  const out: ScorePenalty[] = [];
  const { stopDistancePct, riskReward } = input;
  if (riskReward === null) {
    out.push({ key: "noTarget", points: 6, note: "no technical target above the entry trigger – upside not measurable" });
  } else if (riskReward !== undefined && riskReward < 1) {
    out.push({ key: "riskReward", points: 8, note: `risk/reward ${riskReward.toFixed(2)} – less upside than downside to invalidation` });
  } else if (riskReward !== undefined && riskReward < 1.5) {
    out.push({ key: "riskReward", points: 4, note: `risk/reward ${riskReward.toFixed(2)} – thin` });
  }
  if (stopDistancePct !== undefined && stopDistancePct !== null && stopDistancePct > 12) {
    out.push({
      key: "wideStop",
      points: 4,
      note: `invalidation level ${stopDistancePct.toFixed(1)}% below entry – large downside before the setup is proven wrong`,
    });
  }
  if ((s.rsi14 !== null && s.rsi14 > 80) || s.percentB > 1.2) {
    out.push({ key: "extended", points: 8, note: "price extended far outside the band / RSI > 80 – chase risk" });
  }
  const atrPct = s.atr14 !== null ? (s.atr14 / s.close) * 100 : null;
  if (atrPct !== null && atrPct > 6) out.push({ key: "volatility", points: 6, note: `ATR ${atrPct.toFixed(1)}% of price – high volatility` });
  else if (atrPct !== null && atrPct > 4) out.push({ key: "volatility", points: 3, note: `ATR ${atrPct.toFixed(1)}% of price – elevated volatility` });
  if (s.ma200 !== null && s.close < s.ma200) {
    out.push(
      signal.type === "meanReversion"
        ? { key: "counterTrend", points: 10, note: "below MA200 – bounce against a long-term downtrend (falling-knife risk)" }
        : { key: "counterTrend", points: 6, note: "below MA200 – long-term trend not supportive" }
    );
  }
  if (s.ma200 === null) out.push({ key: "shortHistory", points: 3, note: "MA200 not computable – long-term trend unknown" });
  return out;
}

export function scoreOpportunity(input: ScoreInput): OpportunityScore {
  const { snapshot: s, signal } = input;
  const newsRisk = input.newsRisk;
  const components: ScoreComponent[] = [
    signalComponent(signal),
    trendComponent(s),
    volumeComponent(s),
    liquidityComponent(s),
    momentumComponent(s, signal),
    {
      key: "newsRisk",
      label: "News & event risk",
      points: newsRisk ? newsRisk.points : 5,
      max: 10,
      note: newsRisk ? newsRisk.note : "not yet assessed (pre-rank) – neutral",
    },
    freshnessComponent(input),
  ];
  const pen = penalties(s, signal, input);
  const raw = components.reduce((a, c) => a + c.points, 0) - pen.reduce((a, p) => a + p.points, 0);
  return { total: round1(clamp(raw, 0, 100)), components, penalties: pen };
}
