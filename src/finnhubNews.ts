import axios from "axios";
import { NewsItem } from "./types";

// Alternative news provider tried BEFORE Alpha Vantage's NEWS_SENTIMENT (see
// dataSources.ts's getNews) – reduces how often a run needs to spend an
// Alpha Vantage call on news at all. Requires FINNHUB_API_KEY (free tier);
// when that's not configured this is a deliberate, silent no-op (returns
// null), exactly like fetchFinnhubEarningsForDate – a provider being
// unconfigured must never be reported as "no news".
const FINNHUB_NEWS_URL = "https://finnhub.io/api/v1/company-news";

function toAlphaTimestamp(unixSeconds: number): string {
  const iso = new Date(unixSeconds * 1000).toISOString();
  // "YYYY-MM-DDTHH:MM:SS.sssZ" -> "YYYYMMDDTHHMMSS", matching Alpha
  // Vantage's format so marketStory.ts's parsePublished handles both
  // providers identically.
  return iso.slice(0, 10).replace(/-/g, "") + "T" + iso.slice(11, 19).replace(/:/g, "");
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function fetchFinnhubCompanyNews(symbol: string, lookbackDays = 5): Promise<NewsItem[] | null> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return null;

  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  try {
    const { data } = await axios.get(FINNHUB_NEWS_URL, {
      timeout: 10000,
      params: { symbol, from: ymd(from), to: ymd(to), token: apiKey },
    });
    const rows: any[] = Array.isArray(data) ? data : [];
    return rows
      .filter((r) => r.headline && r.url && typeof r.datetime === "number")
      .map((r) => ({
        title: String(r.headline),
        url: String(r.url),
        source: String(r.source ?? "Finnhub"),
        publishedAt: toAlphaTimestamp(r.datetime),
        summary: r.summary ? String(r.summary) : undefined,
        // Finnhub's free company-news endpoint carries no sentiment/relevance
        // scoring – left undefined rather than fabricated; scoreNews() in
        // marketStory.ts already has honest defaults for both.
        sentimentScore: undefined,
        sentimentLabel: undefined,
        relevanceScore: undefined,
      }))
      .slice(0, 10);
  } catch {
    return null;
  }
}
