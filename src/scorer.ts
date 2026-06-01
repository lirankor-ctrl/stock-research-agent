import { CompanyProfile, NewsItem, ScoreBreakdown, Stock } from "./types";
import { classifyProfile } from "./sectors";
import { isNasdaq100, isSp500 } from "./universe";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// Each sub-score is on a 0..10 scale, then weighted-averaged and penalized.

// 40% – the dominant factor for a long-term investor.
function scoreCompanyQuality(
  profile: CompanyProfile | undefined,
  ticker: string
): number {
  const cls = classifyProfile(profile, ticker);
  let s = 4; // baseline if unknown

  // Preferred index membership.
  if (isNasdaq100(ticker)) s += 1.5;
  if (isSp500(ticker)) s += 1;

  // Large-cap technology is explicitly preferred.
  if (cls.isTechGrowth) s += 1;

  if (profile?.marketCap) {
    if (profile.marketCap >= 200_000_000_000) s += 2.5; // mega cap
    else if (profile.marketCap >= 50_000_000_000) s += 2; // large
    else if (profile.marketCap >= 10_000_000_000) s += 1.5;
    else if (profile.marketCap >= 2_000_000_000) s += 0.5; // mid
  }

  // Established profitability.
  if (profile?.eps !== undefined && profile.eps > 0) s += 0.5;
  if (profile?.profitMargin !== undefined && profile.profitMargin > 0.1) s += 0.5;
  if (profile?.peRatio && profile.peRatio > 0 && profile.peRatio < 60) s += 0.5;

  return clamp(s, 0, 10);
}

// 20% – for a long-term investor moderate, steady momentum beats wild swings.
function scoreMomentum(stock: Stock): number {
  const move = stock.changePercent;
  const abs = Math.abs(move);

  // Reward modest positive momentum, taper hard past ~15%.
  let s: number;
  if (move >= 0) {
    s = move <= 15 ? 5 + move * 0.27 : 9 - (move - 15) * 0.15;
  } else {
    // Pullbacks aren't fatal but score below flat.
    s = 5 + move * 0.2; // move is negative
  }
  return clamp(s, 0, 10);
}

// 20% – liquidity / institutional participation.
function scoreVolume(stock: Stock): number {
  const v = Math.max(stock.volume, 1);
  return clamp(Math.log10(v), 0, 10);
}

// 20% – relevance + sentiment strength of recent coverage.
function scoreNewsQuality(news: NewsItem[]): number {
  if (!news || news.length === 0) return 4; // unknown -> neutral
  const relevant = news.filter((n) => (n.relevanceScore ?? 0) >= 0.3);
  if (relevant.length === 0) return 4;

  let weight = 0;
  let acc = 0;
  for (const n of relevant) {
    const r = n.relevanceScore ?? 0.5;
    const s = n.sentimentScore ?? 0;
    acc += s * r; // signed: positive coverage helps, negative hurts
    weight += r;
  }
  const avgSentiment = weight > 0 ? acc / weight : 0; // ~ -0.5..0.5
  const coverage = Math.min(relevant.length / 5, 1); // 0..1

  // Centre at 5 (neutral), shift by sentiment, small coverage bonus.
  return clamp(5 + avgSentiment * 10 + coverage * 2, 0, 10);
}

// Multiplicative penalty (0..1) for traits a long-term investor should avoid.
function computePenalty(
  stock: Stock,
  profile: CompanyProfile | undefined
): number {
  let p = 1;

  // Negative earnings.
  if (profile?.eps !== undefined && profile.eps < 0) p *= 0.8;
  else if (profile?.profitMargin !== undefined && profile.profitMargin < 0) p *= 0.85;

  // Micro / small caps.
  if (profile?.marketCap !== undefined) {
    if (profile.marketCap < 300_000_000) p *= 0.7; // micro
    else if (profile.marketCap < 2_000_000_000) p *= 0.85; // small
  }

  // Extreme volatility.
  const abs = Math.abs(stock.changePercent);
  if (abs > 25) p *= 0.8;
  else if (abs > 15) p *= 0.92;

  return p;
}

const WEIGHTS = {
  companyQuality: 0.4,
  momentum: 0.2,
  volume: 0.2,
  newsQuality: 0.2,
};

export function scoreStock(
  stock: Stock,
  profile: CompanyProfile | undefined,
  news: NewsItem[]
): ScoreBreakdown {
  const companyQuality = scoreCompanyQuality(profile, stock.ticker);
  const momentum = scoreMomentum(stock);
  const volume = scoreVolume(stock);
  const newsQuality = scoreNewsQuality(news);
  const penalty = computePenalty(stock, profile);

  const weighted =
    companyQuality * WEIGHTS.companyQuality +
    momentum * WEIGHTS.momentum +
    volume * WEIGHTS.volume +
    newsQuality * WEIGHTS.newsQuality;

  const penalized = weighted * penalty;

  // Map 0..10 -> 1..10 (never show a hard 0).
  const total = clamp(Math.round((1 + penalized * 0.9) * 10) / 10, 1, 10);

  return { companyQuality, momentum, volume, newsQuality, penalty, total };
}
