import axios from "axios";
import { EarningsTimingExpectation } from "./types";

// ===== Actual reported earnings results =====
//
// Nasdaq's public calendar (the primary forward-looking provider used
// elsewhere in this codebase) never carries ACTUAL post-report figures –
// only forecasts. Finnhub's /calendar/earnings endpoint is the one already-
// integrated provider that does carry epsActual/revenueActual once a company
// has reported, so it is the (sole) results provider here – not a fallback
// for this specific sub-feature, since nothing else in the stack has this
// data at all. Requires FINNHUB_API_KEY (free tier); when unconfigured this
// is a deliberate, silent no-op – exactly the same graceful-degrade pattern
// as fetchFinnhubEarningsForDate/fetchFinnhubCompanyNews. A provider being
// unconfigured must never be reported as "results unavailable" in a way
// indistinguishable from "we checked and Finnhub genuinely has nothing" –
// callers see the same `null` either way and must not fabricate a
// distinction the data doesn't support.
const FINNHUB_EARNINGS_URL = "https://finnhub.io/api/v1/calendar/earnings";

export interface EarningsResultRow {
  symbol: string;
  date: string; // YYYY-MM-DD – the provider's own confirmed report date
  timeOfDay?: EarningsTimingExpectation;
  epsActual?: number;
  epsEstimate?: number;
  revenueActual?: number;
  revenueEstimate?: number;
}

function parseHour(raw: unknown): EarningsTimingExpectation {
  if (raw === "bmo") return "pre-market";
  if (raw === "amc") return "post-market";
  return "unknown";
}

function numOrUndefined(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

// Queries a small window around the expected date (the actual report can
// land a day or two off the original estimate) and returns every row
// Finnhub has for this symbol in that window – the caller picks the row
// matching (or closest to) the tracked event. Returns [] when Finnhub is
// reachable but genuinely has nothing for this symbol/window (a real
// answer, not a failure), and null only when the fetch itself failed or
// the API key isn't configured.
export async function fetchFinnhubEarningsResult(
  symbol: string,
  aroundDateIso: string,
  windowDays = 3
): Promise<EarningsResultRow[] | null> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return null;

  const around = new Date(`${aroundDateIso}T00:00:00Z`);
  const from = new Date(around.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const to = new Date(around.getTime() + windowDays * 24 * 60 * 60 * 1000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  try {
    const { data } = await axios.get(FINNHUB_EARNINGS_URL, {
      timeout: 10000,
      params: { symbol, from: ymd(from), to: ymd(to), token: apiKey },
    });
    const rows: any[] = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
    return rows
      .map((r): EarningsResultRow | null => {
        const rowSymbol = String(r.symbol ?? "").trim().toUpperCase();
        const date = String(r.date ?? "").trim();
        if (!rowSymbol || !date) return null;
        return {
          symbol: rowSymbol,
          date,
          timeOfDay: parseHour(r.hour),
          epsActual: numOrUndefined(r.epsActual),
          epsEstimate: numOrUndefined(r.epsEstimate),
          revenueActual: numOrUndefined(r.revenueActual),
          revenueEstimate: numOrUndefined(r.revenueEstimate),
        };
      })
      .filter((r): r is EarningsResultRow => r !== null);
  } catch {
    return null;
  }
}
