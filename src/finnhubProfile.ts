import axios from "axios";
import { throttleFinnhub } from "./finnhubThrottle";
import { CompanyProfile } from "./types";

// Alternative fundamentals provider tried BEFORE Alpha Vantage's OVERVIEW
// (see dataSources.ts's getOverview).
//
// OVERVIEW was the single largest remaining Alpha Vantage cost: one call per
// stock, ~27 stocks per run, against a 25/day free-tier ceiling — so the
// live-call budget was exhausted mid-universe on every cold run and the
// remaining stocks came back with no profile at all. Finnhub's free tier
// covers the same fields across two endpoints, and (like the news and
// earnings-calendar providers already here) is a deliberate silent no-op when
// FINNHUB_API_KEY isn't configured, so an unconfigured provider is never
// reported as "this company has no fundamentals".
const PROFILE_URL = "https://finnhub.io/api/v1/stock/profile2";
const METRIC_URL = "https://finnhub.io/api/v1/stock/metric";

function num(raw: any): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// Returns null when Finnhub is unconfigured or the profile call fails —
// both mean "ask the next provider", never "no such company".
export async function fetchFinnhubProfile(symbol: string): Promise<CompanyProfile | null> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return null;

  let profile: any;
  try {
    const { data } = await throttleFinnhub(() =>
      axios.get(PROFILE_URL, {
        timeout: 10000,
        params: { symbol, token: apiKey },
      })
    );
    profile = data;
  } catch {
    return null;
  }
  // Finnhub answers an unknown symbol with `{}` rather than an error.
  if (!profile || !profile.name) return null;

  // The metric endpoint is a separate call and a separate failure domain:
  // losing the ratios must not throw away the identity/market-cap fields the
  // Top Opportunities gate actually depends on.
  let metric: any = {};
  try {
    const { data } = await throttleFinnhub(() =>
      axios.get(METRIC_URL, {
        timeout: 10000,
        params: { symbol, metric: "all", token: apiKey },
      })
    );
    metric = data?.metric ?? {};
  } catch {
    metric = {};
  }

  const industry = profile.finnhubIndustry ? String(profile.finnhubIndustry) : undefined;
  const marketCapMillions = num(profile.marketCapitalization);
  // Finnhub reports market cap in MILLIONS of USD; the rest of this codebase
  // (filters.ts's $2B floor, the categorizer, the report) expects absolute
  // dollars exactly as Alpha Vantage's OVERVIEW returns them. Getting this
  // wrong would silently filter out every stock.
  const marketCap = marketCapMillions !== undefined ? marketCapMillions * 1e6 : undefined;

  // Finnhub reports these two as percentages (21.3 = 21.3%); Alpha Vantage
  // reports them as fractions (0.213), which is what CompanyProfile means.
  const profitMarginPct = num(metric.netProfitMarginTTM);
  const dividendYieldPct = num(metric.dividendYieldIndicatedAnnual);

  return {
    symbol: String(profile.ticker ?? symbol),
    name: String(profile.name),
    exchange: profile.exchange ? String(profile.exchange) : undefined,
    sector: industry,
    industry,
    marketCap,
    country: profile.country ? String(profile.country) : undefined,
    peRatio: num(metric.peBasicExclExtraTTM) ?? num(metric.peTTM),
    eps: num(metric.epsBasicExclExtraItemsTTM) ?? num(metric.epsTTM),
    profitMargin: profitMarginPct !== undefined ? profitMarginPct / 100 : undefined,
    dividendPerShare: num(metric.dividendPerShareAnnual),
    dividendYield: dividendYieldPct !== undefined ? dividendYieldPct / 100 : undefined,
  };
}
