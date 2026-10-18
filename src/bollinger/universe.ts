// Scan universe for Bollinger opportunity discovery.
//
// A curated list of established, liquid US-listed large- and mid-caps across
// every sector (Yahoo symbols – e.g. BRK-B). It is deliberately a static,
// reviewed list rather than a screener: no free provider here offers a
// reliable market-wide screener, and a static list can't silently drift into
// penny stocks or OTC names. Daily qualifying movers are added on top at run
// time, and every name still has to pass the live liquidity / exchange /
// instrument-type filters in scan.ts – membership here is not a free pass.
//
// Known limitation: survivorship/curation bias – names are what's
// established today, so the list must be reviewed periodically.
import { MEGA_CAP_PRIORITY, WATCHLIST } from "../universe";

const SECTOR_LISTS: Record<string, string[]> = {
  technology: [
    "AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "ADBE", "AMD", "INTC", "QCOM", "TXN", "AMAT", "LRCX",
    "KLAC", "MU", "ADI", "MRVL", "SNPS", "CDNS", "NOW", "INTU", "IBM", "CSCO", "ANET", "PANW", "CRWD",
    "FTNT", "ZS", "DDOG", "NET", "MDB", "SNOW", "PLTR", "SHOP", "WDAY", "ADSK", "TEAM", "TSM", "ASML",
    "ARM", "DELL", "HPQ", "TTD", "APP",
  ],
  communication: ["GOOGL", "META", "NFLX", "DIS", "T", "VZ", "TMUS", "CMCSA", "SPOT"],
  consumer: [
    "AMZN", "TSLA", "HD", "LOW", "MCD", "SBUX", "NKE", "COST", "WMT", "TGT", "BKNG", "MAR", "HLT", "CMG",
    "LULU", "ORLY", "AZO", "TJX", "ROST", "UBER", "ABNB", "DASH", "DG",
  ],
  staples: ["PG", "KO", "PEP", "PM", "MO", "CL", "MDLZ", "KHC", "GIS"],
  financials: [
    "JPM", "BAC", "WFC", "C", "GS", "MS", "SCHW", "BLK", "AXP", "V", "MA", "PYPL", "COF", "SPGI", "MCO",
    "ICE", "CME", "USB", "PNC", "KKR", "BX", "APO", "BRK-B", "SOFI",
  ],
  healthcare: [
    "LLY", "UNH", "JNJ", "ABBV", "MRK", "PFE", "TMO", "DHR", "ABT", "ISRG", "VRTX", "REGN", "GILD", "AMGN",
    "BMY", "MDT", "SYK", "BSX", "ZTS", "ELV", "CVS", "CI", "HCA", "DXCM",
  ],
  industrials: [
    "CAT", "DE", "GE", "HON", "UNP", "UPS", "RTX", "LMT", "NOC", "GD", "BA", "ETN", "EMR", "ITW", "MMM",
    "CSX", "NSC", "FDX", "WM", "URI", "PH",
  ],
  energy: ["XOM", "CVX", "COP", "EOG", "SLB", "OXY", "MPC", "PSX", "VLO", "KMI", "WMB"],
  materials: ["LIN", "APD", "SHW", "FCX", "NEM", "ECL", "NUE"],
  utilities: ["NEE", "DUK", "SO", "AEP", "VST", "CEG"],
  realEstate: ["PLD", "AMT", "EQIX", "O", "SPG"],
};

// Yahoo uses "-" for share classes (BRK-B); the rest of the codebase uses ".".
export function toYahooSymbol(ticker: string): string {
  return ticker.toUpperCase().replace(/\./g, "-");
}

export function bollingerUniverse(extraTickers: string[] = []): string[] {
  const all = [
    ...WATCHLIST.map((w) => w.ticker),
    ...MEGA_CAP_PRIORITY,
    ...Object.values(SECTOR_LISTS).flat(),
    ...extraTickers,
  ].map(toYahooSymbol);
  return Array.from(new Set(all));
}
