import { getYahooDailyCloses } from "./dataSources";
import { computeTechnicals } from "./technicals";
import { watchlistName } from "./universe";
import {
  BandProximity,
  EnrichedStock,
  ExpansionItem,
  TechnicalAlert,
  TechnicalAlerts,
} from "./types";

// How many names to surface in each fallback / expansion list.
const TOP_N = 3;

export interface TechnicalOptions {
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

export interface TechnicalRecord {
  ticker: string;
  name: string;
  price: number;
  upper: number;
  lower: number;
  rsi14: number;
  widthChangePct: number | null;
}

export interface TechnicalResult {
  alerts: TechnicalAlerts;
  available: Set<string>;   // tickers for which Bollinger/RSI were computable
  rateLimited: Set<string>; // tickers whose daily-closes couldn't be fetched
  byTicker: Map<string, TechnicalRecord>; // for the compact Technical Watch table
}

// Fetch daily closes from Yahoo Finance (cache-first, independent of Alpha
// Vantage – Priority 3: RSI/Bollinger Bands are always computed LOCALLY from
// this raw price history, never requested from Alpha Vantage), compute
// Bollinger Bands + RSI, and split into above-upper / below-lower alerts.
// Never throws – stocks without enough history are simply skipped.
export async function buildTechnicalAlerts(
  stocks: EnrichedStock[],
  opts: TechnicalOptions = {}
): Promise<TechnicalResult> {
  const { onProgress = () => {} } = opts;
  const candidates = dedupeByTicker(stocks);

  const aboveUpper: TechnicalAlert[] = [];
  const belowLower: TechnicalAlert[] = [];
  const available = new Set<string>();
  const rateLimited = new Set<string>();
  const byTicker = new Map<string, TechnicalRecord>();
  const records: TechnicalRecord[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i];
    onProgress(`  [${i + 1}/${candidates.length}] technicals ${s.ticker} ...`);

    const res = await getYahooDailyCloses(s.ticker, (m) => onProgress(`     ${m}`));

    const closes = res.value;
    if (!closes) {
      if (res.source.source === "unavailable") rateLimited.add(s.ticker);
      continue;
    }

    const tech = computeTechnicals(closes);
    if (!tech) continue;

    available.add(s.ticker);
    const name = displayName(s);

    const record: TechnicalRecord = {
      ticker: s.ticker,
      name,
      price: tech.price,
      upper: tech.bands.upper,
      lower: tech.bands.lower,
      rsi14: tech.rsi14,
      widthChangePct: tech.widthChangePct,
    };
    records.push(record);
    byTicker.set(s.ticker, record);

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

  // Closest to the UPPER band = smallest positive gap below it.
  const closestToUpper: BandProximity[] = records
    .filter((r) => r.price <= r.upper && r.upper > 0)
    .map((r) => ({
      ticker: r.ticker,
      name: r.name,
      price: r.price,
      distancePct: ((r.upper - r.price) / r.upper) * 100,
      rsi14: r.rsi14,
    }))
    .sort((a, b) => a.distancePct - b.distancePct)
    .slice(0, TOP_N);

  // Closest to the LOWER band = smallest positive gap above it.
  const closestToLower: BandProximity[] = records
    .filter((r) => r.price >= r.lower && r.lower > 0)
    .map((r) => ({
      ticker: r.ticker,
      name: r.name,
      price: r.price,
      distancePct: ((r.price - r.lower) / r.lower) * 100,
      rsi14: r.rsi14,
    }))
    .sort((a, b) => a.distancePct - b.distancePct)
    .slice(0, TOP_N);

  // Largest recent band-width increase first (volatility expanding).
  const expansion: ExpansionItem[] = records
    .filter((r) => r.widthChangePct !== null)
    .map((r) => ({
      ticker: r.ticker,
      name: r.name,
      widthChangePct: r.widthChangePct as number,
      rsi14: r.rsi14,
    }))
    .sort((a, b) => b.widthChangePct - a.widthChangePct)
    .slice(0, TOP_N);

  // No usable daily data at all AND we were blocked → the section should say
  // so clearly rather than render empty tables. If cache supplied closes,
  // `records` is non-empty and this stays false.
  const dataUnavailable = records.length === 0 && rateLimited.size > 0;

  return {
    alerts: {
      aboveUpper,
      belowLower,
      closestToUpper,
      closestToLower,
      expansion,
      dataUnavailable,
    },
    available,
    rateLimited,
    byTicker,
  };
}

export interface TechnicalWatchPrice {
  price: number;
  changePercent: number;
  isLastClose: boolean;
}

// Priority for the Technical Watch table's price column: live/cached quote
// first; when that's unavailable, fall back to the latest close from the
// SAME historical dataset RSI/Bollinger were computed from (never leave a
// valid RSI sitting next to "Price unavailable" when we actually have a
// price, just not a fresh quote for it). A historical close carries no
// reliable "today" change, so changePercent is 0 and the caller must label
// it "Last close" rather than rendering a fabricated daily move.
export function resolveTechnicalWatchPrice(
  quotePrice: number,
  quoteChangePercent: number,
  record: TechnicalRecord | undefined
): TechnicalWatchPrice {
  if (quotePrice > 0) {
    return { price: quotePrice, changePercent: quoteChangePercent, isLastClose: false };
  }
  const fallbackPrice = record?.price ?? 0;
  return { price: fallbackPrice, changePercent: 0, isLastClose: fallbackPrice > 0 };
}

// Short Hebrew "technical status" label for a single ticker – used by the Top
// Opportunities cards and the compact Technical Watch table. Reuses the
// already-computed alerts rather than issuing new fetches.
export function technicalStatusHebrew(ticker: string, alerts: TechnicalAlerts): string {
  if (alerts.aboveUpper.some((a) => a.ticker === ticker)) return "🔴 מעל הרצועה העליונה";
  if (alerts.belowLower.some((a) => a.ticker === ticker)) return "🟢 מתחת לרצועה התחתונה";
  if (alerts.closestToUpper.some((a) => a.ticker === ticker)) return "🔥 קרוב לרצועה העליונה";
  if (alerts.closestToLower.some((a) => a.ticker === ticker)) return "🟡 קרוב לרצועה התחתונה";
  if (alerts.dataUnavailable) return "— לא זמין";
  return "⚪ ניטרלי";
}
