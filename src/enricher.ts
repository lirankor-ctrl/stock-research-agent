import {
  fetchCompanyOverview,
  fetchNewsForTicker,
  sleep,
} from "./alphaVantage";
import { explainWhyHebrew } from "./explainer";
import { passesProfileFilter } from "./filters";
import { scoreStock } from "./scorer";
import { CompanyProfile, EnrichedStock, NewsItem, Stock } from "./types";

// Free Alpha Vantage tier = 5 requests/minute. We do 2 requests per ticker.
// 13s between requests keeps us comfortably under that ceiling.
const REQUEST_DELAY_MS = 13_000;

export interface EnrichOptions {
  apiKey: string;
  maxTickers?: number;
  delayMs?: number;
  onProgress?: (msg: string) => void;
}

export async function enrichStocks(
  stocks: Stock[],
  opts: EnrichOptions
): Promise<EnrichedStock[]> {
  const {
    apiKey,
    maxTickers = 10,
    delayMs = REQUEST_DELAY_MS,
    onProgress = () => {},
  } = opts;

  const subset = stocks.slice(0, maxTickers);
  const enriched: EnrichedStock[] = [];

  for (let i = 0; i < subset.length; i++) {
    const s = subset[i];
    onProgress(
      `  [${i + 1}/${subset.length}] enriching ${s.ticker} ...`
    );

    let profile: CompanyProfile | undefined;
    let news: NewsItem[] = [];
    try {
      profile = (await fetchCompanyOverview(s.ticker, apiKey)) ?? undefined;
    } catch (err: any) {
      onProgress(`     ⚠️  profile error: ${err.message}`);
    }
    await sleep(delayMs);

    try {
      news = await fetchNewsForTicker(s.ticker, apiKey, 5);
    } catch (err: any) {
      onProgress(`     ⚠️  news error: ${err.message}`);
      news = [];
    }
    // Don't sleep after the last call
    if (i < subset.length - 1) await sleep(delayMs);

    if (!passesProfileFilter(s, profile)) {
      onProgress(`     ⛔  filtered out (exchange/price): ${s.ticker}`);
      continue;
    }

    const score = scoreStock(s, profile, news ?? []);
    const whyHebrew = explainWhyHebrew(s, profile, news ?? []);

    enriched.push({
      ...s,
      profile,
      news: news ?? [],
      whyHebrew,
      score,
      finalScore: score.total,
    });
  }

  enriched.sort((a, b) => b.finalScore - a.finalScore);
  return enriched;
}
