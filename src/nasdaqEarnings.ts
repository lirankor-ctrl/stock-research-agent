import axios from "axios";

// Nasdaq's public earnings-calendar endpoint – no API key, independent of
// Alpha Vantage. Queried once per calendar date (the endpoint only accepts a
// single date, not a range), each result cached 24h so a run only re-fetches
// dates it hasn't already seen today.
const NASDAQ_EARNINGS_URL = "https://api.nasdaq.com/api/calendar/earnings";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  Accept: "application/json",
};

export interface NasdaqEarningsRow {
  symbol: string;
  name: string;
  timeOfDay?: "pre-market" | "post-market";
  epsForecast?: number;
  lastYearEPS?: number;
  marketCap?: number;
  // Nasdaq's public calendar never carries a revenue estimate – stays
  // undefined for rows from this provider. Populated only by the Finnhub
  // secondary/fallback provider (see finnhubEarnings.ts), when configured.
  revenueForecast?: number;
}

function parseMoneyLike(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[$,]/g, "").trim();
  if (!cleaned || cleaned.toLowerCase() === "n/a") return undefined;
  const n = Number(cleaned);
  return Number.isNaN(n) ? undefined : n;
}

function parseTimeOfDay(raw: unknown): "pre-market" | "post-market" | undefined {
  if (raw === "time-pre-market") return "pre-market";
  if (raw === "time-after-hours") return "post-market";
  return undefined;
}

// Returns [] when the date genuinely has no reporting companies (a normal,
// confirmed empty result), and null only when the fetch itself failed – the
// caller must keep these two cases distinct.
export async function fetchNasdaqEarningsForDate(
  dateIso: string
): Promise<NasdaqEarningsRow[] | null> {
  try {
    const { data } = await axios.get(NASDAQ_EARNINGS_URL, {
      timeout: 10000,
      params: { date: dateIso },
      headers: HEADERS,
    });
    const rows: any[] = data?.data?.rows ?? [];
    return rows
      .map((r) => ({
        symbol: String(r.symbol ?? "").trim().toUpperCase(),
        name: String(r.name ?? "").trim(),
        timeOfDay: parseTimeOfDay(r.time),
        epsForecast: parseMoneyLike(r.epsForecast),
        lastYearEPS: parseMoneyLike(r.lastYearEPS),
        marketCap: parseMoneyLike(r.marketCap),
      }))
      .filter((r) => r.symbol.length > 0);
  } catch {
    return null;
  }
}
