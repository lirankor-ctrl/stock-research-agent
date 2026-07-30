import axios from "axios";
import {
  AlphaVantageMoversResponse,
  CompanyProfile,
  NewsItem,
} from "./types";

const BASE_URL = "https://www.alphavantage.co/query";

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

// Alpha Vantage returns 200 OK with a `Note` or `Information` field
// when you hit the daily/per-minute quota. Convert that to a typed error
// so callers can distinguish quota issues from real network failures.
function checkApiError(data: any, context: string): void {
  const noteOrInfo: string | undefined = data?.Note ?? data?.Information;
  if (!noteOrInfo) return;

  const lower = noteOrInfo.toLowerCase();
  if (
    lower.includes("api") ||
    lower.includes("limit") ||
    lower.includes("rate") ||
    lower.includes("premium") ||
    lower.includes("call frequency")
  ) {
    throw new RateLimitError(`Alpha Vantage quota hit (${context}): ${noteOrInfo}`);
  }
  throw new Error(`Alpha Vantage info (${context}): ${noteOrInfo}`);
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

  const num = (raw: any): number | undefined =>
    raw !== undefined && raw !== null && raw !== "None" && raw !== ""
      ? Number(raw)
      : undefined;

  const str = (raw: any): string | undefined =>
    raw !== undefined && raw !== null && raw !== "None" && raw !== ""
      ? String(raw)
      : undefined;

  return {
    symbol: data.Symbol,
    name: data.Name,
    exchange: data.Exchange,
    sector: data.Sector,
    industry: data.Industry,
    marketCap: num(data.MarketCapitalization),
    description: data.Description,
    country: data.Country,
    peRatio: num(data.PERatio),
    eps: num(data.EPS),
    profitMargin: num(data.ProfitMargin),
    dividendPerShare: num(data.DividendPerShare),
    dividendYield: num(data.DividendYield),
    exDividendDate: str(data.ExDividendDate),
    dividendDate: str(data.DividendDate),
  };
}

// Lightweight current-price + daily-change lookup for tickers that aren't in
// the movers list (e.g. stable watchlist names). One API call per ticker.
export interface Quote {
  price: number;
  changePercent: number;
  volume: number;
}

export async function fetchQuote(
  symbol: string,
  apiKey: string
): Promise<Quote | null> {
  const { data } = await axios.get(BASE_URL, {
    params: { function: "GLOBAL_QUOTE", symbol, apikey: apiKey },
    timeout: 15000,
  });
  checkApiError(data, `GLOBAL_QUOTE ${symbol}`);

  const q = data?.["Global Quote"];
  if (!q || !q["05. price"]) return null;

  const price = parseFloat(q["05. price"]);
  const changePercent = parseFloat(
    String(q["10. change percent"] ?? "").replace("%", "")
  );
  const volume = parseInt(q["06. volume"] ?? "0", 10);

  if (Number.isNaN(price)) return null;

  return {
    price,
    changePercent: Number.isNaN(changePercent) ? 0 : changePercent,
    volume: Number.isNaN(volume) ? 0 : volume,
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

  items.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
  return items.slice(0, limit);
}

// ===== Economic indicators (latest released reading) =====
// Note: TREASURY_YIELD is intentionally NOT here – Yahoo Finance's ^TNX
// (see marketData.ts) gives the real 10-year yield without competing for
// Alpha Vantage's daily quota, so Market Overview uses that instead.

export type EconomicIndicatorFn = "CPI" | "UNEMPLOYMENT" | "REAL_GDP" | "FEDERAL_FUNDS_RATE";

export interface EconomicIndicatorPoint {
  date: string;
  value: number;
}

export async function fetchEconomicIndicator(
  fn: EconomicIndicatorFn,
  apiKey: string
): Promise<EconomicIndicatorPoint | null> {
  const params: Record<string, string> = { function: fn, apikey: apiKey };
  if (fn === "CPI" || fn === "FEDERAL_FUNDS_RATE") {
    params.interval = "monthly";
  } else if (fn === "REAL_GDP") {
    params.interval = "quarterly";
  }

  const { data } = await axios.get(BASE_URL, {
    params,
    timeout: 15000,
  });
  checkApiError(data, fn);

  const series: any[] = Array.isArray(data?.data) ? data.data : [];
  if (series.length === 0) return null;
  const latest = series[0]; // Alpha Vantage returns newest-first
  const value = parseFloat(latest?.value);
  if (!latest?.date || Number.isNaN(value)) return null;
  return { date: latest.date, value };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
