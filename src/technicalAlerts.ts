import { sleep } from "./alphaVantage";
import { getDailyCloses } from "./dataSources";
import { computeTechnicals } from "./technicals";
import { watchlistName } from "./universe";
import { EnrichedStock, TechnicalAlert, TechnicalAlerts } from "./types";
import { LiveBudget } from "./enricher";

export interface TechnicalOptions {
  apiKey: string;
  budget: LiveBudget;
  delayMs: number;
  onProgress?: (msg: string) => void;
}

function displayName(s: EnrichedStock): string {
  return s.profile?.name ?? watchlistName(s.ticker) ?? s.ticker;
}

// Unique stocks by ticker, preferring the first occurrence (watchlist order).
function dedupeByTicker(stocks: EnrichedStock[]): EnrichedStock[] {
  const seen = new Set<string>();
  const out: EnrichedStock[] = [];
  for (const s of stocks) {
    if (seen.has(s.ticker)) continue;
    seen.add(s.ticker);
    out.push(s);
  }
  return out;
}

export interface TechnicalResult {
  alerts: TechnicalAlerts;
  available: Set<string>;   // tickers for which Bollinger/RSI were computable
  rateLimited: Set<string>; // tickers whose daily-closes couldn't be fetched (budget/API)
}

// Fetch daily closes (cache-first, budget-aware) for every watchlist + report
// stock, compute Bollinger Bands + RSI, and split into above-upper / below-lower
// alerts. Never throws – stocks without enough history are simply skipped.
// Also reports which tickers yielded usable technical data (for data quality).
export async function buildTechnicalAlerts(
  stocks: EnrichedStock[],
  opts: TechnicalOptions
): Promise<TechnicalResult> {
  const { apiKey, budget, delayMs, onProgress = () => {} } = opts;
  const candidates = dedupeByTicker(stocks);

  const aboveUpper: TechnicalAlert[] = [];
  const belowLower: TechnicalAlert[] = [];
  const available = new Set<string>();
  const rateLimited = new Set<string>();

  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i];
    onProgress(`  [${i + 1}/${candidates.length}] technicals ${s.ticker} ...`);

    const res = await getDailyCloses(
      s.ticker,
      apiKey,
      (m) => onProgress(`     ${m}`),
      budget.allow
    );
    budget.note(res.source);
    if (res.source.source === "live" && i < candidates.length - 1) {
      await sleep(delayMs);
    }

    const closes = res.value;
    if (!closes) {
      // Distinguish "couldn't fetch" (rate limit) from "no data at all".
      if (res.source.source === "unavailable") rateLimited.add(s.ticker);
      continue;
    }

    const tech = computeTechnicals(closes);
    if (!tech) continue;

    available.add(s.ticker);
    const name = displayName(s);

    if (tech.price > tech.bands.upper) {
      aboveUpper.push({
        ticker: s.ticker,
        name,
        price: tech.price,
        band: tech.bands.upper,
        pctFromBand: ((tech.price - tech.bands.upper) / tech.bands.upper) * 100,
        rsi14: tech.rsi14,
      });
    } else if (tech.price < tech.bands.lower) {
      belowLower.push({
        ticker: s.ticker,
        name,
        price: tech.price,
        band: tech.bands.lower,
        pctFromBand: ((tech.bands.lower - tech.price) / tech.bands.lower) * 100,
        rsi14: tech.rsi14,
      });
    }
  }

  // Most extreme first.
  aboveUpper.sort((a, b) => b.pctFromBand - a.pctFromBand);
  belowLower.sort((a, b) => b.pctFromBand - a.pctFromBand);

  return { alerts: { aboveUpper, belowLower }, available, rateLimited };
}
