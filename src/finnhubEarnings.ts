import axios from "axios";
import { NasdaqEarningsRow } from "./nasdaqEarnings";

// Secondary earnings-calendar provider – independent of both Alpha Vantage
// and Nasdaq, used ONLY when the primary Nasdaq lookup for a date fails
// (network/API error). Requires FINNHUB_API_KEY (free tier); when that's not
// configured this is a deliberate, silent no-op – the caller falls through
// to stale cache and then "unavailable", exactly like any other provider
// that isn't reachable. A provider being unconfigured must never be reported
// as "no companies reporting".
const FINNHUB_EARNINGS_URL = "https://finnhub.io/api/v1/calendar/earnings";

function parseHour(raw: unknown): "pre-market" | "post-market" | undefined {
  if (raw === "bmo") return "pre-market";
  if (raw === "amc") return "post-market";
  return undefined;
}

export async function fetchFinnhubEarningsForDate(
  dateIso: string
): Promise<NasdaqEarningsRow[] | null> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return null;

  try {
    const { data } = await axios.get(FINNHUB_EARNINGS_URL, {
      timeout: 10000,
      params: { from: dateIso, to: dateIso, token: apiKey },
    });
    const rows: any[] = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
    return rows
      .map((r) => {
        const symbol = String(r.symbol ?? "").trim().toUpperCase();
        return {
          symbol,
          // Finnhub's free calendar endpoint doesn't return a display name
          // or market cap – the caller's own trackedCompanyName()/ranking
          // floor already handle a symbol-only row gracefully.
          name: symbol,
          timeOfDay: parseHour(r.hour),
          epsForecast: typeof r.epsEstimate === "number" ? r.epsEstimate : undefined,
          lastYearEPS: undefined,
          marketCap: undefined,
          revenueForecast: typeof r.revenueEstimate === "number" ? r.revenueEstimate : undefined,
        };
      })
      .filter((r) => r.symbol.length > 0);
  } catch {
    return null;
  }
}
