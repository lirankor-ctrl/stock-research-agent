import { sleep } from "./alphaVantage";
import { classifyTier } from "./categorizer";
import { getNews, getOverview, getQuote } from "./dataSources";
import { explainLongTermWhyHebrew, explainWhyHebrew } from "./explainer";
import { passesLongTermFilter } from "./filters";
import { scoreStock } from "./scorer";
import { WATCHLIST, watchlistName } from "./universe";
import {
  CompanyProfile,
  EnrichedStock,
  NewsItem,
  SourceInfo,
  Stock,
} from "./types";

// Conservative gap between LIVE API calls so we don't trip the 5/min limit.
// Cached hits skip the sleep – they're free.
export const REQUEST_DELAY_MS = 13_000;

// Default cap on fresh API calls per run (free tier is 25/day; movers spends 1).
export const DEFAULT_LIVE_BUDGET = 22;

// Tracks how many fresh (non-cached) API calls we may still make this run.
export class LiveBudget {
  constructor(public remaining: number) {}
  get allow(): boolean {
    return this.remaining > 0;
  }
  note(src: SourceInfo): void {
    if (src.source === "live") this.remaining = Math.max(0, this.remaining - 1);
  }
}

export interface EnrichOptions {
  apiKey: string;
  budget: LiveBudget;
  delayMs?: number;
  onProgress?: (msg: string) => void;
}

export interface EnrichResult {
  stocks: EnrichedStock[];
  liveCalls: number;
  cachedCalls: number;
  unavailableCalls: number;
}

function buildEnriched(
  s: Stock,
  profile: CompanyProfile | undefined,
  news: NewsItem[],
  profileSource: SourceInfo,
  newsSource: SourceInfo
): EnrichedStock {
  const score = scoreStock(s, profile, news);
  const enriched: EnrichedStock = {
    ...s,
    profile,
    news,
    whyHebrew: explainWhyHebrew(s, profile, news),
    longTermWhyHebrew: explainLongTermWhyHebrew(s, profile, news),
    tier: "none",
    score,
    finalScore: score.total,
    profileSource,
    newsSource,
  };
  enriched.tier = classifyTier(enriched);
  return enriched;
}

// ===== Watchlist: needs a quote first (these names aren't in the movers list) =====

export async function buildWatchlistStocks(
  opts: EnrichOptions
): Promise<{ stocks: Stock[]; tally: Tally }> {
  const { apiKey, budget, delayMs = REQUEST_DELAY_MS, onProgress = () => {} } = opts;
  const tally = newTally();
  const stocks: Stock[] = [];

  for (const w of WATCHLIST) {
    const res = await getQuote(
      w.ticker,
      apiKey,
      (m) => onProgress(`     ${m}`),
      budget.allow
    );
    recordTally(tally, res.source);
    budget.note(res.source);
    if (res.source.source === "live") await sleep(delayMs);

    stocks.push({
      ticker: w.ticker,
      price: res.value?.price ?? 0,
      changePercent: res.value?.changePercent ?? 0,
      volume: res.value?.volume ?? 0,
      category: "active",
      origin: "watchlist",
      preScore: 0,
    });
  }

  return { stocks, tally };
}

// ===== Generic enrichment (overview + news) for any Stock list =====

export async function enrichStocks(
  candidates: Stock[],
  opts: EnrichOptions
): Promise<EnrichResult> {
  const { apiKey, budget, delayMs = REQUEST_DELAY_MS, onProgress = () => {} } = opts;
  const tally = newTally();
  const enriched: EnrichedStock[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i];
    onProgress(`  [${i + 1}/${candidates.length}] enriching ${s.ticker} ...`);

    const profileRes = await getOverview(
      s.ticker,
      apiKey,
      (m) => onProgress(`     ${m}`),
      budget.allow
    );
    recordTally(tally, profileRes.source);
    budget.note(profileRes.source);
    if (profileRes.source.source === "live") await sleep(delayMs);

    const newsRes = await getNews(
      s.ticker,
      apiKey,
      (m) => onProgress(`     ${m}`),
      budget.allow
    );
    recordTally(tally, newsRes.source);
    budget.note(newsRes.source);
    if (newsRes.source.source === "live" && i < candidates.length - 1) {
      await sleep(delayMs);
    }

    const profile = profileRes.value ?? undefined;
    const news = newsRes.value ?? [];

    if (!passesLongTermFilter(s, profile)) {
      onProgress(`     ⛔  filtered out (long-term rules): ${s.ticker}`);
      continue;
    }

    enriched.push(buildEnriched(s, profile, news, profileRes.source, newsRes.source));
  }

  enriched.sort((a, b) => b.finalScore - a.finalScore);
  return {
    stocks: enriched,
    liveCalls: tally.live,
    cachedCalls: tally.cached,
    unavailableCalls: tally.unavailable,
  };
}

// Skeleton for watchlist names we couldn't enrich (so the table still renders).
export function buildSkeletonEnriched(s: Stock): EnrichedStock {
  return buildEnriched(
    s,
    undefined,
    [],
    { source: "unavailable" },
    { source: "unavailable" }
  );
}

// ===== tally helpers =====

interface Tally {
  live: number;
  cached: number;
  unavailable: number;
}
function newTally(): Tally {
  return { live: 0, cached: 0, unavailable: 0 };
}
function recordTally(t: Tally, src: SourceInfo): void {
  if (src.source === "live") t.live++;
  else if (src.source === "cached") t.cached++;
  else t.unavailable++;
}
