// Curated investable universe for a long-term investor.
//
// The watchlist is the quality anchor of the report: these names are always
// shown and always bypass the speculative-exclusion filters. The Nasdaq-100 /
// S&P-500 sets are CURATED SUBSETS (large, well-known members) used only to
// award a "preferred index member" bonus in scoring – they are intentionally
// not exhaustive.

export interface WatchlistEntry {
  ticker: string;
  name: string;
}

// Always included in the Watchlist section (order preserved).
export const WATCHLIST: WatchlistEntry[] = [
  { ticker: "SOFI", name: "SoFi Technologies" },
  { ticker: "AMZN", name: "Amazon.com" },
  { ticker: "MSFT", name: "Microsoft" },
  { ticker: "NVDA", name: "NVIDIA" },
  { ticker: "META", name: "Meta Platforms" },
  { ticker: "GOOGL", name: "Alphabet" },
  { ticker: "PANW", name: "Palo Alto Networks" },
  { ticker: "CRWD", name: "CrowdStrike" },
  { ticker: "PLTR", name: "Palantir Technologies" },
];

export const WATCHLIST_TICKERS = new Set(WATCHLIST.map((w) => w.ticker));

// Mega-cap US companies that move the broad market – used only to decide
// which non-watchlist names are worth surfacing in the earnings calendar.
export const MEGA_CAP_PRIORITY: string[] = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO",
  "JPM", "V", "UNH", "LLY",
];

// Display names for mega-cap tickers not already in WATCHLIST.
export const MEGA_CAP_NAMES: Record<string, string> = {
  AAPL: "Apple Inc.",
  TSLA: "Tesla Inc.",
  AVGO: "Broadcom Inc.",
  JPM: "JPMorgan Chase & Co.",
  V: "Visa Inc.",
  UNH: "UnitedHealth Group",
  LLY: "Eli Lilly and Company",
};

export function trackedCompanyName(ticker: string): string {
  return watchlistName(ticker) ?? MEGA_CAP_NAMES[ticker.toUpperCase()] ?? ticker;
}

// Every ticker the newsletter's calendar-style sections (earnings calendar,
// earnings follow-up) should always check – independent of whether the
// ticker happened to pass today's movers/quality scan.
export function trackedTickers(): Array<{ ticker: string; name: string }> {
  const seen = new Set<string>();
  const out: Array<{ ticker: string; name: string }> = [];
  for (const w of WATCHLIST) {
    if (seen.has(w.ticker)) continue;
    seen.add(w.ticker);
    out.push({ ticker: w.ticker, name: w.name });
  }
  for (const t of MEGA_CAP_PRIORITY) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ ticker: t, name: trackedCompanyName(t) });
  }
  return out;
}

export function watchlistName(ticker: string): string | undefined {
  return WATCHLIST.find((w) => w.ticker === ticker.toUpperCase())?.name;
}

// Curated subset of Nasdaq-100 members (large-cap tech / growth).
export const NASDAQ_100 = new Set([
  "AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "META", "AMZN", "TSLA", "AVGO",
  "ADBE", "COST", "PEP", "CSCO", "NFLX", "AMD", "INTC", "QCOM", "TXN", "AMAT",
  "INTU", "BKNG", "ISRG", "MU", "LRCX", "ADI", "REGN", "VRTX", "PANW", "KLAC",
  "SNPS", "CDNS", "MRVL", "CRWD", "FTNT", "ABNB", "PDD", "MELI", "ASML", "ARM",
  "PLTR", "ADP", "GILD", "MDLZ", "CTAS", "ORLY", "CSX", "MAR", "MCHP", "ROP",
]);

// Curated subset of S&P-500 members (broad large-caps across sectors).
export const SP_500 = new Set([
  ...NASDAQ_100,
  "BRK.B", "JPM", "V", "MA", "UNH", "JNJ", "PG", "HD", "XOM", "CVX", "BAC",
  "WMT", "KO", "DIS", "ORCL", "CRM", "ACN", "MCD", "ABT", "NKE", "WFC", "TMO",
  "LIN", "PM", "DHR", "VZ", "TXN", "NEE", "BMY", "RTX", "UPS", "LOW", "GS",
  "CAT", "SPGI", "BLK", "AXP", "T", "PFE", "C", "MS", "NOW", "UBER", "SHOP",
]);

export function isNasdaq100(ticker: string): boolean {
  return NASDAQ_100.has(ticker.toUpperCase());
}

export function isSp500(ticker: string): boolean {
  return SP_500.has(ticker.toUpperCase());
}

export function isIndexMember(ticker: string): boolean {
  return isNasdaq100(ticker) || isSp500(ticker);
}
