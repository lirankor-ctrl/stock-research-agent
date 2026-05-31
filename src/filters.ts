import { CompanyProfile, RawMover, Stock } from "./types";

export const MIN_PRICE_USD = 5;

const MAJOR_EXCHANGES = new Set([
  "NASDAQ", "NYSE", "NYSE ARCA", "NYSE MKT", "NYSE AMERICAN", "BATS", "CBOE",
]);

// Heuristic: ticker patterns that usually indicate OTC / foreign ADR pink sheets
// - 5+ letters ending in F, Y, or Q (often OTC ADRs / bankrupt)
// - contains "." or "-" suffixes (e.g. BRK.A is legit, but pink sheets often use .PK)
const OTC_LIKELY_SUFFIXES = /\.(PK|OB)$/i;

export function isLikelyOtcTicker(ticker: string): boolean {
  if (!ticker) return true;
  if (OTC_LIKELY_SUFFIXES.test(ticker)) return true;
  // Tickers > 4 chars ending with F/Y are often ADRs traded OTC
  if (ticker.length >= 5 && /[FY]$/.test(ticker)) return true;
  // Anything with a Q suffix on 5+ letters often = bankruptcy / OTC
  if (ticker.length >= 5 && /Q$/.test(ticker)) return true;
  return false;
}

export function passesPreFilter(raw: RawMover): boolean {
  const price = parseFloat(raw.price);
  if (Number.isNaN(price) || price < MIN_PRICE_USD) return false;
  if (!raw.ticker || isLikelyOtcTicker(raw.ticker)) return false;
  // Skip clearly malformed entries
  if (!/^[A-Z][A-Z0-9.\-]{0,5}$/i.test(raw.ticker)) return false;
  return true;
}

export function passesProfileFilter(
  stock: Stock,
  profile?: CompanyProfile
): boolean {
  if (stock.price < MIN_PRICE_USD) return false;
  if (!profile) return true; // keep if we couldn't load profile (Alpha Vantage is flaky)
  if (profile.exchange) {
    const ex = profile.exchange.toUpperCase();
    const ok = Array.from(MAJOR_EXCHANGES).some((m) => ex.includes(m));
    if (!ok) return false;
  }
  return true;
}
