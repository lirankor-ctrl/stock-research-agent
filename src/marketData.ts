import axios from "axios";
import { usMarketDateIso } from "./dateUtils";

// Yahoo Finance's unofficial (but widely used, no-key) chart endpoint. Used
// for market indices/commodities/crypto (Priority 2) and for daily
// closing-price history so Bollinger/RSI can be computed LOCALLY (Priority 3)
// instead of depending on Alpha Vantage's TIME_SERIES_DAILY, which competes
// with the daily quota needed for stock-specific enrichment.
const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

async function fetchYahooChart(
  symbol: string,
  params: { range: string; interval: string }
): Promise<any | null> {
  try {
    const { data } = await axios.get(`${YAHOO_CHART_BASE}/${encodeURIComponent(symbol)}`, {
      timeout: 10000,
      params,
      headers: HEADERS,
    });
    const result = data?.chart?.result?.[0];
    return result ?? null;
  } catch {
    return null;
  }
}

export interface YahooQuote {
  price: number;
  previousClose: number;
  changePercent: number;
  volume: number; // 0 when Yahoo's chart meta doesn't carry a volume figure
}

export async function fetchYahooQuote(symbol: string): Promise<YahooQuote | null> {
  const result = await fetchYahooChart(symbol, { range: "5d", interval: "1d" });
  if (!result) return null;
  const meta = result.meta ?? {};
  const price = meta.regularMarketPrice;
  const previousClose = meta.previousClose ?? meta.chartPreviousClose;
  if (typeof price !== "number" || typeof previousClose !== "number" || previousClose === 0) {
    return null;
  }
  const volume = typeof meta.regularMarketVolume === "number" ? meta.regularMarketVolume : 0;
  return {
    price,
    previousClose,
    changePercent: ((price - previousClose) / previousClose) * 100,
    volume,
  };
}

// ~6 months of daily closes – enough for 20-day Bollinger Bands, RSI(14),
// and a 5-day band-width trend, computed locally in technicals.ts.
export async function fetchYahooDailyCloses(symbol: string): Promise<number[] | null> {
  const result = await fetchYahooChart(symbol, { range: "6mo", interval: "1d" });
  if (!result) return null;
  const raw: Array<number | null> = result.indicators?.quote?.[0]?.close ?? [];
  const closes = raw.filter((c): c is number => typeof c === "number" && c > 0);
  return closes.length > 0 ? closes : null;
}

export interface DatedClose {
  date: string; // YYYY-MM-DD, US/Eastern trading date (matches Nasdaq/Finnhub earnings dates)
  close: number;
}

// Same ~6mo daily-close series as fetchYahooDailyCloses, but paired with each
// close's actual trading date instead of a bare array. This is what makes an
// earnings-reaction calculation trustworthy: Yahoo's series contains ONLY
// real trading days (weekends/holidays are simply absent), so walking one
// index before/after a given date is always a genuine adjacent trading day –
// see src/earningsReaction.ts.
export async function fetchYahooDailyClosesWithDates(symbol: string): Promise<DatedClose[] | null> {
  const result = await fetchYahooChart(symbol, { range: "6mo", interval: "1d" });
  if (!result) return null;
  const timestamps: Array<number | null> = result.timestamp ?? [];
  const raw: Array<number | null> = result.indicators?.quote?.[0]?.close ?? [];
  const out: DatedClose[] = [];
  for (let i = 0; i < Math.min(timestamps.length, raw.length); i++) {
    const ts = timestamps[i];
    const close = raw[i];
    if (typeof ts !== "number" || typeof close !== "number" || close <= 0) continue;
    // Yahoo's chart timestamps are UTC seconds at the session's start; the US
    // market date formatter (dateUtils.ts) already exists precisely to avoid
    // UTC-midnight date drift for this kind of US-market-date derivation.
    out.push({ date: usMarketDateIso(new Date(ts * 1000)), close });
  }
  return out.length > 0 ? out : null;
}
