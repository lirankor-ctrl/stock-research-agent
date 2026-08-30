import {
  EconomicIndicatorFn,
  EconomicIndicatorPoint,
  fetchCompanyOverview,
  fetchEconomicIndicator,
  fetchNewsForTicker,
  fetchQuote,
  fetchTopMovers,
  Quote,
  RateLimitError,
} from "./alphaVantage";
import { readCache, TTL, writeCache } from "./cache";
import { fetchFinnhubEarningsForDate } from "./finnhubEarnings";
import { fetchFinnhubCompanyNews } from "./finnhubNews";
import { fetchYahooDailyCloses, fetchYahooQuote, YahooQuote } from "./marketData";
import { fetchNasdaqEarningsForDate, NasdaqEarningsRow } from "./nasdaqEarnings";
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
// When allowLive is false (live-call budget exhausted) the live step is
// skipped entirely and we fall straight through to the stale-cache fallback.
export async function cacheFirst<T>(
  cacheKey: string,
  freshTtlMs: number,
  fetcher: () => Promise<T | null>,
  onNote: (msg: string) => void,
  allowLive = true
): Promise<SourcedValue<T>> {
  // 1. Fresh cache hit
  const fresh = readCache<T>(cacheKey, freshTtlMs);
  if (fresh) {
    return {
      value: fresh.data,
      source: { source: "cached", ageHours: round1(fresh.ageHours) },
    };
  }

  if (!allowLive) {
    const cached = readCache<T>(cacheKey, STALE_FALLBACK_MS);
    if (cached) {
      return {
        value: cached.data,
        source: { source: "cached", ageHours: round1(cached.ageHours) },
      };
    }
    return { value: null, source: { source: "unavailable" } };
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

// ===== Alpha Vantage (budget-gated via allowLive) =====

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

// Fundamentals (name/sector/marketCap/P-E/EPS/margin/dividends) barely move
// day to day – a 7-day cache means most days re-use yesterday's OVERVIEW
// call for free instead of spending part of the 25/day Alpha Vantage budget
// on data that hasn't actually changed.
export async function getOverview(
  symbol: string,
  apiKey: string,
  onNote: (msg: string) => void = () => {},
  allowLive = true
): Promise<SourcedValue<CompanyProfile>> {
  return cacheFirst<CompanyProfile>(
    `overview_${symbol}`,
    TTL.DAYS_7,
    () => fetchCompanyOverview(symbol, apiKey),
    onNote,
    allowLive
  );
}

// Both getQuote and getNews try a non-Alpha provider FIRST and only fall
// back to Alpha Vantage when that provider has nothing. `usedAlpha` tells
// the caller whether THIS call actually touched the Alpha Vantage live
// budget / 5-per-minute rate limit, so it can call budget.note()/sleep()
// only when genuinely warranted – a naive "source === live -> it was Alpha"
// assumption (the pre-existing convention, back when getQuote/getNews were
// 100% Alpha) would otherwise silently burn through the scarce Alpha budget
// on free, unbudgeted Yahoo/Finnhub calls, and add pointless 13s
// rate-limit sleeps after them too.
export interface ProviderResult<T> extends SourcedValue<T> {
  usedAlpha: boolean;
}

// News tries Finnhub's free company-news endpoint FIRST (silent no-op when
// FINNHUB_API_KEY isn't configured – same graceful-degrade pattern as
// fetchFinnhubEarningsForDate) so a normal run doesn't have to spend an
// Alpha Vantage call on news at all when Finnhub already covers it.
export async function getNews(
  symbol: string,
  apiKey: string,
  onNote: (msg: string) => void = () => {},
  allowLive = true
): Promise<ProviderResult<NewsItem[]>> {
  const cacheKey = `news_${symbol}`;
  // Fresh cache short-circuits before touching either provider.
  const fresh = readCache<NewsItem[]>(cacheKey, TTL.HOURS_24);
  if (fresh) {
    return { value: fresh.data, source: { source: "cached", ageHours: round1(fresh.ageHours) }, usedAlpha: false };
  }

  const finnhub = await fetchFinnhubCompanyNews(symbol);
  if (finnhub !== null) {
    // Finnhub reachable (configured) – even a genuinely empty result is a
    // real answer, and never a reason to also spend an Alpha call.
    writeCache(cacheKey, finnhub);
    return { value: finnhub, source: { source: "live" }, usedAlpha: false };
  }
  onNote(`Finnhub news unavailable for ${symbol} (not configured or fetch failed) – falling back to Alpha Vantage`);
  const alpha = await cacheFirst<NewsItem[]>(cacheKey, TTL.HOURS_24, () => fetchNewsForTicker(symbol, apiKey, 5), onNote, allowLive);
  return { ...alpha, usedAlpha: true };
}

// Quotes try Yahoo Finance FIRST (no key, no daily-budget gate – see
// marketData.ts, already used elsewhere in this file for indices/technicals)
// and only fall back to Alpha Vantage's GLOBAL_QUOTE when Yahoo has nothing
// AND the live-call budget allows it. This is the single biggest Alpha
// Vantage reduction: the watchlist's ~10 daily GLOBAL_QUOTE calls move to a
// provider with no shared daily quota at all.
export async function getQuote(
  symbol: string,
  apiKey: string,
  onNote: (msg: string) => void = () => {},
  allowLive = true
): Promise<ProviderResult<Quote>> {
  const yahoo = await getYahooQuote(symbol, onNote);
  if (yahoo.value) {
    return {
      value: { price: yahoo.value.price, changePercent: yahoo.value.changePercent, volume: yahoo.value.volume },
      source: yahoo.source,
      usedAlpha: false,
    };
  }
  onNote(`Yahoo quote unavailable for ${symbol} – falling back to Alpha Vantage`);
  // Quotes go stale fast – keep the fresh window short so the daily report
  // reflects the latest close.
  const alpha = await cacheFirst<Quote>(
    `quote_${symbol}`,
    TTL.HOURS_12,
    () => fetchQuote(symbol, apiKey),
    onNote,
    allowLive
  );
  return { ...alpha, usedAlpha: true };
}

// Latest released macro reading (CPI/unemployment/GDP/Fed funds rate) – not a
// forward calendar, and these series only update monthly/quarterly, so a
// 7-day cache avoids re-spending a live call on a value that can't have
// changed since yesterday. Treasury yield comes from Yahoo (real ^TNX)
// instead, see getYahooTreasuryYield below.
export async function getEconomicIndicator(
  fn: EconomicIndicatorFn,
  apiKey: string,
  onNote: (msg: string) => void = () => {},
  allowLive = true
): Promise<SourcedValue<EconomicIndicatorPoint>> {
  return cacheFirst<EconomicIndicatorPoint>(
    `econ_${fn}`,
    TTL.DAYS_7,
    () => fetchEconomicIndicator(fn, apiKey),
    onNote,
    allowLive
  );
}

// ===== Yahoo Finance (independent of Alpha Vantage – no daily-budget gate,
// slow-moving market data so a 12h fresh window keeps calls minimal) =====

export async function getYahooQuote(
  symbol: string,
  onNote: (msg: string) => void = () => {}
): Promise<SourcedValue<YahooQuote>> {
  return cacheFirst<YahooQuote>(
    `yahoo_quote_${symbol}`,
    TTL.HOURS_12,
    () => fetchYahooQuote(symbol),
    onNote
  );
}

export async function getYahooDailyCloses(
  symbol: string,
  onNote: (msg: string) => void = () => {}
): Promise<SourcedValue<number[]>> {
  return cacheFirst<number[]>(
    `yahoo_daily_${symbol}`,
    TTL.HOURS_12,
    () => fetchYahooDailyCloses(symbol),
    onNote
  );
}

// ===== Nasdaq earnings calendar (independent of Alpha Vantage – one call per
// calendar date, 24h cache so a run only re-fetches dates it hasn't already
// seen today) =====

// Provider chain for a single calendar date: Nasdaq (primary) -> Finnhub
// (secondary, only when Nasdaq's fetch itself fails) -> [cacheFirst below
// then also tries stale cache] -> unavailable. A date genuinely having zero
// reporting companies (Nasdaq returns []) is NOT a failure and never
// triggers the secondary provider – only a real fetch error does.
async function fetchEarningsWithFallback(
  dateIso: string,
  onNote: (msg: string) => void
): Promise<NasdaqEarningsRow[] | null> {
  const primary = await fetchNasdaqEarningsForDate(dateIso);
  if (primary !== null) return primary;

  onNote(`Nasdaq earnings calendar unavailable for ${dateIso} – trying secondary provider (Finnhub)`);
  const secondary = await fetchFinnhubEarningsForDate(dateIso);
  if (secondary !== null) return secondary;

  return null; // both providers failed – cacheFirst falls through to stale cache, then "unavailable"
}

export async function getNasdaqEarningsForDate(
  dateIso: string,
  onNote: (msg: string) => void = () => {}
): Promise<SourcedValue<NasdaqEarningsRow[]>> {
  return cacheFirst<NasdaqEarningsRow[]>(
    `nasdaq_earnings_${dateIso}`,
    TTL.HOURS_24,
    () => fetchEarningsWithFallback(dateIso, onNote),
    onNote
  );
}
