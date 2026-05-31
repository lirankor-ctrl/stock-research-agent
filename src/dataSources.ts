import {
  fetchCompanyOverview,
  fetchNewsForTicker,
  fetchTopMovers,
  RateLimitError,
} from "./alphaVantage";
import { readCache, TTL, writeCache } from "./cache";
import {
  AlphaVantageMoversResponse,
  CompanyProfile,
  NewsItem,
  SourceInfo,
} from "./types";

export interface SourcedValue<T> {
  value: T | null;
  source: SourceInfo;
}

const STALE_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7d – any cache is better than nothing

// Generic helper: cache-first, then API, then stale-cache fallback.
async function cacheFirst<T>(
  cacheKey: string,
  freshTtlMs: number,
  fetcher: () => Promise<T | null>,
  onNote: (msg: string) => void
): Promise<SourcedValue<T>> {
  // 1. Fresh cache hit
  const fresh = readCache<T>(cacheKey, freshTtlMs);
  if (fresh) {
    return {
      value: fresh.data,
      source: { source: "cached", ageHours: round1(fresh.ageHours) },
    };
  }

  // 2. Try live API
  try {
    const live = await fetcher();
    if (live !== null && live !== undefined) {
      writeCache(cacheKey, live);
      return { value: live, source: { source: "live" } };
    }
    // API returned nothing – fall through to stale fallback
  } catch (err: any) {
    if (err instanceof RateLimitError) {
      onNote(`⚠️  rate limit on ${cacheKey} – trying stale cache`);
    } else {
      onNote(`⚠️  API error on ${cacheKey}: ${err.message} – trying stale cache`);
    }
  }

  // 3. Stale cache fallback
  const stale = readCache<T>(cacheKey, STALE_FALLBACK_MS);
  if (stale) {
    return {
      value: stale.data,
      source: { source: "cached", ageHours: round1(stale.ageHours) },
    };
  }

  // 4. Nothing
  return { value: null, source: { source: "unavailable" } };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function getTopMovers(
  apiKey: string,
  onNote: (msg: string) => void = () => {}
): Promise<SourcedValue<AlphaVantageMoversResponse>> {
  return cacheFirst<AlphaVantageMoversResponse>(
    "movers",
    TTL.HOURS_12,
    () => fetchTopMovers(apiKey),
    onNote
  );
}

export async function getOverview(
  symbol: string,
  apiKey: string,
  onNote: (msg: string) => void = () => {}
): Promise<SourcedValue<CompanyProfile>> {
  return cacheFirst<CompanyProfile>(
    `overview_${symbol}`,
    TTL.HOURS_24,
    () => fetchCompanyOverview(symbol, apiKey),
    onNote
  );
}

export async function getNews(
  symbol: string,
  apiKey: string,
  onNote: (msg: string) => void = () => {}
): Promise<SourcedValue<NewsItem[]>> {
  return cacheFirst<NewsItem[]>(
    `news_${symbol}`,
    TTL.HOURS_24,
    () => fetchNewsForTicker(symbol, apiKey, 5),
    onNote
  );
}
