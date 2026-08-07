import { CompanyProfile, RawMover, Stock } from "./types";
import { WATCHLIST_TICKERS } from "./universe";

// ===== Long-term investor thresholds =====
export const MIN_PRICE_USD = 10;
export const MIN_MARKET_CAP = 2_000_000_000; // $2B
export const LARGE_CAP = 10_000_000_000; // $10B – exempts extreme movers
export const MAX_DAILY_MOVE = 40; // % – above this is speculative unless mega-cap

const MAJOR_EXCHANGES = new Set([
  "NASDAQ", "NYSE", "NYSE ARCA", "NYSE MKT", "NYSE AMERICAN", "BATS", "CBOE",
]);

// Pink-sheet / OTC ADR suffixes.
const OTC_LIKELY_SUFFIXES = /\.(PK|OB)$/i;
// Warrants (ABCDW, .WS, -WT) and units (ABCDU, .U, -UN) and rights (ABCDR).
const WARRANT_SUFFIXES = /(\.WS|-WT|-WTA?)$/i;
const UNIT_SUFFIXES = /(\.U|-UN|=)$/i;

export function isLikelyOtcTicker(ticker: string): boolean {
  if (!ticker) return true;
  if (OTC_LIKELY_SUFFIXES.test(ticker)) return true;
  // 5+ letters ending in F/Y → usually foreign ADRs traded OTC.
  if (ticker.length >= 5 && /[FY]$/.test(ticker)) return true;
  // 5+ letters ending in Q → bankruptcy / OTC.
  if (ticker.length >= 5 && /Q$/.test(ticker)) return true;
  return false;
}

// Warrants, units, rights and SPAC leftovers are not suitable long-term equity.
export function isExcludedSecurity(ticker: string): boolean {
  if (!ticker) return true;
  const t = ticker.toUpperCase();
  if (WARRANT_SUFFIXES.test(t) || UNIT_SUFFIXES.test(t)) return true;
  // Single-letter 5th-char markers on 5-char tickers: W=warrant, U=unit, R=rights.
  if (t.length === 5 && /[WUR]$/.test(t)) return true;
  if (isLikelyOtcTicker(t)) return true;
  return false;
}

// Cheap pre-filter on raw movers (no profile yet): price floor + obvious junk.
// The market-cap and extreme-move rules are applied later, once we have a profile.
export function passesPreFilter(raw: RawMover): boolean {
  const ticker = (raw.ticker || "").toUpperCase();
  // Watchlist names are always allowed through.
  if (WATCHLIST_TICKERS.has(ticker)) return true;

  const price = parseFloat(raw.price);
  if (Number.isNaN(price) || price < MIN_PRICE_USD) return false;
  if (!ticker || isExcludedSecurity(ticker)) return false;
  if (!/^[A-Z][A-Z0-9.\-]{0,5}$/i.test(ticker)) return false;
  return true;
}

// Full long-term suitability filter, applied after enrichment when we know the
// company profile. Watchlist names bypass the exclusions (hand-picked quality).
//
// `profile` is undefined in two very different situations, and conflating
// them is exactly the "gives up too early" bug this function used to have:
//   1. The OVERVIEW call was rate-limited / errored (a provider outage) –
//      we simply don't know this candidate's exchange/market-cap yet.
//   2. The OVERVIEW call succeeded (live or cached) and genuinely returned
//      nothing – Alpha Vantage has no profile for this symbol at all.
// A live, real price from the movers feed is still real signal. A provider
// outage must never by itself discard a candidate – that's a confidence
// problem for computeDataQuality to reflect (lower coverage/confidence,
// keeping it out of Top Opportunities unless everything else checks out),
// not a reason to pretend the candidate never existed. Only case 2 – or a
// profile that actively disqualifies the stock – is grounds to drop it here.
export function passesLongTermFilter(
  stock: Stock,
  profile?: CompanyProfile,
  profileFetchFailed = false
): boolean {
  if (stock.origin === "watchlist") return true;

  if (stock.price < MIN_PRICE_USD) return false;
  if (isExcludedSecurity(stock.ticker)) return false;

  // Extreme daily move is only tolerated for confirmed mega-caps (> $10B).
  // With no profile we can't confirm the exemption, but if that's because
  // the provider failed (not because we checked and it's a small-cap) we
  // still don't reject – dataQuality will already mark it low-confidence.
  const cap = profile?.marketCap ?? 0;
  if (Math.abs(stock.changePercent) > MAX_DAILY_MOVE && cap < LARGE_CAP && !profileFetchFailed) {
    return false;
  }

  // No profile at all: keep the candidate when every provider simply failed
  // (unknown, not disqualified) – drop it only when we actually reached the
  // source and it confirmed there's nothing there.
  if (!profile) return profileFetchFailed;

  if (profile.exchange) {
    const ex = profile.exchange.toUpperCase();
    const onMajor = Array.from(MAJOR_EXCHANGES).some((m) => ex.includes(m));
    if (!onMajor) return false;
  }

  if (profile.marketCap !== undefined && profile.marketCap < MIN_MARKET_CAP) {
    return false;
  }

  return true;
}
