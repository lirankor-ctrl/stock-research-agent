import { CompanyProfile, NewsItem, ScoreBreakdown, Stock } from "./types";
import { classifyProfile } from "./sectors";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// Each sub-score is on a 0..10 scale, then we weighted-average to 1..10.

function scorePriceMove(stock: Stock): number {
  const abs = Math.abs(stock.changePercent);
  // 0% -> 0, 5% -> 5, 10%+ -> ~8, 20%+ -> 10
  return clamp(abs * 0.7, 0, 10);
}

function scoreVolume(stock: Stock): number {
  // log10 mapping: 100k -> 5, 1M -> 6, 10M -> 7, 100M -> 8...
  const v = Math.max(stock.volume, 1);
  return clamp(Math.log10(v) - 0, 0, 10);
}

function scoreNewsQuality(news: NewsItem[]): number {
  if (!news || news.length === 0) return 3; // unknown -> neutral-low
  const relevant = news.filter((n) => (n.relevanceScore ?? 0) >= 0.3);
  if (relevant.length === 0) return 4;

  // Average abs sentiment, weighted by relevance
  let weight = 0;
  let acc = 0;
  for (const n of relevant) {
    const r = n.relevanceScore ?? 0.5;
    const s = Math.abs(n.sentimentScore ?? 0);
    acc += s * r;
    weight += r;
  }
  const avgSentimentStrength = weight > 0 ? acc / weight : 0; // 0..~0.5

  // Coverage bonus: more relevant stories = better
  const coverage = Math.min(relevant.length / 5, 1); // 0..1

  // Map: strength contributes up to ~7, coverage adds up to 3
  return clamp(avgSentimentStrength * 15 + coverage * 3, 0, 10);
}

function scoreCompanyQuality(
  profile: CompanyProfile | undefined,
  ticker: string
): number {
  const cls = classifyProfile(profile, ticker);
  let s = 4; // baseline if unknown

  if (cls.isTechGrowth) s += 3;

  if (profile?.marketCap) {
    // Mid+ caps are generally higher quality / more researchable
    if (profile.marketCap >= 10_000_000_000) s += 2; // large cap
    else if (profile.marketCap >= 2_000_000_000) s += 1.5; // mid cap
    else if (profile.marketCap >= 300_000_000) s += 0.5; // small cap
    // micro caps: no bonus
  }

  if (profile?.peRatio && profile.peRatio > 0 && profile.peRatio < 80) {
    s += 0.5; // sane profitability
  }

  return clamp(s, 0, 10);
}

function scoreMarketCap(profile: CompanyProfile | undefined): number {
  if (!profile?.marketCap) return 3;
  const mc = profile.marketCap;
  if (mc >= 200_000_000_000) return 10; // mega cap
  if (mc >= 50_000_000_000) return 9;
  if (mc >= 10_000_000_000) return 8; // large
  if (mc >= 2_000_000_000) return 6; // mid
  if (mc >= 500_000_000) return 4; // small
  if (mc >= 100_000_000) return 2; // micro
  return 1;
}

// Weights sum to 1.0
const WEIGHTS = {
  priceMove: 0.25,
  volume: 0.15,
  newsQuality: 0.25,
  companyQuality: 0.25,
  marketCap: 0.10,
};

export function scoreStock(
  stock: Stock,
  profile: CompanyProfile | undefined,
  news: NewsItem[]
): ScoreBreakdown {
  const priceMove = scorePriceMove(stock);
  const volume = scoreVolume(stock);
  const newsQuality = scoreNewsQuality(news);
  const companyQuality = scoreCompanyQuality(profile, stock.ticker);
  const marketCap = scoreMarketCap(profile);

  const raw =
    priceMove * WEIGHTS.priceMove +
    volume * WEIGHTS.volume +
    newsQuality * WEIGHTS.newsQuality +
    companyQuality * WEIGHTS.companyQuality +
    marketCap * WEIGHTS.marketCap;

  // Map 0..10 -> 1..10 (never show a hard 0)
  const total = clamp(Math.round((1 + raw * 0.9) * 10) / 10, 1, 10);

  return { priceMove, volume, newsQuality, companyQuality, marketCap, total };
}
