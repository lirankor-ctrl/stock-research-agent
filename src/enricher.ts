import { sleep } from "./alphaVantage";
import { getNews, getOverview } from "./dataSources";
import { explainWhyHebrew } from "./explainer";
import { passesProfileFilter } from "./filters";
import { scoreStock } from "./scorer";
import {
  CompanyProfile,
  EnrichedStock,
  NewsItem,
  SourceInfo,
  Stock,
} from "./types";

// Conservative gap between live API calls so we don't trip the 5/min limit.
// Cached hits skip the sleep – they're free.
const REQUEST_DELAY_MS = 13_000;

// Free tier is 25 calls/day. We use 1 for movers, leaving 24.
// Enriching 3 tickers × 2 calls = 6 live calls (worst case) – well within budget.
export const DEFAULT_ENRICH_TOP_N = 3;

export interface EnrichResult {
  stocks: EnrichedStock[];
  liveCalls: number;
  cachedCalls: number;
  unavailableCalls: number;
}

export interface EnrichOptions {
  apiKey: string;
  topN?: number;
  delayMs?: number;
  onProgress?: (msg: string) => void;
}

function buildLightEnriched(
  s: Stock,
  profile: CompanyProfile | undefined,
  news: NewsItem[],
  profileSource: SourceInfo,
  newsSource: SourceInfo
): EnrichedStock {
  const score = scoreStock(s, profile, news);
  return {
    ...s,
    profile,
    news,
    whyHebrew: explainWhyHebrew(s, profile, news),
    score,
    finalScore: score.total,
    profileSource,
    newsSource,
  };
}

export async function enrichStocks(
  candidates: Stock[],
  opts: EnrichOptions
): Promise<EnrichResult> {
  const {
    apiKey,
    topN = DEFAULT_ENRICH_TOP_N,
    delayMs = REQUEST_DELAY_MS,
    onProgress = () => {},
  } = opts;

  const subset = candidates.slice(0, topN);
  const enriched: EnrichedStock[] = [];

  let liveCalls = 0;
  let cachedCalls = 0;
  let unavailableCalls = 0;

  const tally = (src: SourceInfo) => {
    if (src.source === "live") liveCalls++;
    else if (src.source === "cached") cachedCalls++;
    else unavailableCalls++;
  };

  for (let i = 0; i < subset.length; i++) {
    const s = subset[i];
    onProgress(`  [${i + 1}/${subset.length}] enriching ${s.ticker} ...`);

    const profileRes = await getOverview(s.ticker, apiKey, (m) =>
      onProgress(`     ${m}`)
    );
    tally(profileRes.source);
    if (profileRes.source.source === "live") await sleep(delayMs);

    const newsRes = await getNews(s.ticker, apiKey, (m) =>
      onProgress(`     ${m}`)
    );
    tally(newsRes.source);
    if (
      newsRes.source.source === "live" &&
      i < subset.length - 1 // don't sleep after the very last call
    ) {
      await sleep(delayMs);
    }

    const profile = profileRes.value ?? undefined;
    const news = newsRes.value ?? [];

    if (!passesProfileFilter(s, profile)) {
      onProgress(`     ⛔  filtered out (exchange/price): ${s.ticker}`);
      continue;
    }

    enriched.push(
      buildLightEnriched(s, profile, news, profileRes.source, newsRes.source)
    );
  }

  enriched.sort((a, b) => b.finalScore - a.finalScore);

  return { stocks: enriched, liveCalls, cachedCalls, unavailableCalls };
}

// Build a minimal EnrichedStock for candidates that didn't go through API enrichment.
// Used so Top Movers / Negative / Most Active sections still have rows.
export function buildSkeletonEnriched(s: Stock): EnrichedStock {
  const score = scoreStock(s, undefined, []);
  return {
    ...s,
    profile: undefined,
    news: [],
    whyHebrew: explainWhyHebrew(s, undefined, []),
    score,
    finalScore: score.total,
    profileSource: { source: "unavailable" },
    newsSource: { source: "unavailable" },
  };
}
