import axios from "axios";
import {
  AlphaVantageMoversResponse,
  CompanyProfile,
  NewsItem,
} from "./types";

const BASE_URL = "https://www.alphavantage.co/query";

function checkApiError(data: any, context: string): void {
  if (data?.Note) {
    throw new Error(`Alpha Vantage rate limit (${context}): ${data.Note}`);
  }
  if (data?.Information) {
    throw new Error(`Alpha Vantage info (${context}): ${data.Information}`);
  }
}

export async function fetchTopMovers(
  apiKey: string
): Promise<AlphaVantageMoversResponse> {
  const { data } = await axios.get<AlphaVantageMoversResponse>(BASE_URL, {
    params: { function: "TOP_GAINERS_LOSERS", apikey: apiKey },
    timeout: 15000,
  });
  checkApiError(data, "TOP_GAINERS_LOSERS");
  return data;
}

export async function fetchCompanyOverview(
  symbol: string,
  apiKey: string
): Promise<CompanyProfile | null> {
  const { data } = await axios.get(BASE_URL, {
    params: { function: "OVERVIEW", symbol, apikey: apiKey },
    timeout: 15000,
  });
  checkApiError(data, `OVERVIEW ${symbol}`);

  if (!data || !data.Symbol) return null;

  const marketCapRaw = data.MarketCapitalization;
  const peRaw = data.PERatio;

  return {
    symbol: data.Symbol,
    name: data.Name,
    exchange: data.Exchange,
    sector: data.Sector,
    industry: data.Industry,
    marketCap: marketCapRaw && marketCapRaw !== "None"
      ? Number(marketCapRaw)
      : undefined,
    description: data.Description,
    country: data.Country,
    peRatio: peRaw && peRaw !== "None" ? Number(peRaw) : undefined,
  };
}

export async function fetchNewsForTicker(
  symbol: string,
  apiKey: string,
  limit = 5
): Promise<NewsItem[]> {
  const { data } = await axios.get(BASE_URL, {
    params: {
      function: "NEWS_SENTIMENT",
      tickers: symbol,
      limit: 20,
      sort: "LATEST",
      apikey: apiKey,
    },
    timeout: 15000,
  });
  checkApiError(data, `NEWS_SENTIMENT ${symbol}`);

  const feed: any[] = Array.isArray(data?.feed) ? data.feed : [];

  const items: NewsItem[] = feed.map((item: any) => {
    const tickerEntry = (item.ticker_sentiment ?? []).find(
      (t: any) => t.ticker === symbol
    );
    return {
      title: item.title ?? "",
      url: item.url ?? "",
      source: item.source ?? "",
      publishedAt: item.time_published ?? "",
      summary: item.summary,
      sentimentScore: tickerEntry
        ? parseFloat(tickerEntry.ticker_sentiment_score)
        : parseFloat(item.overall_sentiment_score),
      sentimentLabel:
        tickerEntry?.ticker_sentiment_label ?? item.overall_sentiment_label,
      relevanceScore: tickerEntry
        ? parseFloat(tickerEntry.relevance_score)
        : undefined,
    };
  });

  // Prefer high-relevance items first
  items.sort(
    (a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0)
  );

  return items.slice(0, limit);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
