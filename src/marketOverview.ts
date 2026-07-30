import { getYahooQuote } from "./dataSources";
import { FearGreed, MarketOverviewItem } from "./types";

// Independent of Alpha Vantage – Yahoo Finance's real symbols, no proxies
// needed for VIX or the 10-year yield anymore (^VIX and ^TNX are the actual
// indices). Gold/Oil use the standard tracked futures (GC=F / CL=F), which
// are the real commodity price, not an ETF proxy.
const SYMBOLS: Array<{ key: string; symbol: string; label: string; unit?: string; noteHebrew?: string }> = [
  { key: "sp500", symbol: "SPY", label: "S&P 500 (SPY)" },
  { key: "nasdaq", symbol: "QQQ", label: "NASDAQ (QQQ)" },
  { key: "russell2000", symbol: "IWM", label: "Russell 2000 (IWM)" },
  { key: "vix", symbol: "^VIX", label: "VIX", noteHebrew: "מדד התנודתיות הרשמי (לא proxy)" },
  { key: "treasuryYield10y", symbol: "^TNX", label: "US 10-Year Treasury Yield", unit: "%" },
  { key: "gold", symbol: "GC=F", label: "Gold (Futures)" },
  { key: "oil", symbol: "CL=F", label: "Oil – WTI (Futures)" },
  { key: "bitcoin", symbol: "BTC-USD", label: "Bitcoin (BTC/USD)" },
];

export interface MarketOverviewOptions {
  onProgress?: (msg: string) => void;
  fearGreed: FearGreed | null;
}

export async function buildMarketOverview(opts: MarketOverviewOptions): Promise<MarketOverviewItem[]> {
  const { onProgress = () => {}, fearGreed } = opts;
  const items: MarketOverviewItem[] = [];

  items.push(
    fearGreed
      ? {
          key: "fearGreed",
          label: "Fear & Greed Index",
          value: fearGreed.score,
          changePercent: null,
          noteHebrew: fearGreed.hebrew,
          isProxy: false,
          source: { source: "live" },
        }
      : {
          key: "fearGreed",
          label: "Fear & Greed Index",
          value: null,
          changePercent: null,
          isProxy: false,
          source: { source: "unavailable" },
        }
  );

  for (const s of SYMBOLS) {
    const res = await getYahooQuote(s.symbol, (m) => onProgress(`   ${m}`));
    items.push({
      key: s.key,
      label: s.label,
      value: res.value?.price ?? null,
      changePercent: res.value?.changePercent ?? null,
      unit: s.unit,
      noteHebrew: s.noteHebrew,
      isProxy: false,
      source: res.source,
    });
  }

  return items;
}

// Minimum indicators (with an actual value) required before rendering the
// full table – below this the section collapses into one short notice
// instead of a sparse, mostly-empty table.
export const MIN_VISIBLE_INDICATORS = 5;

export function visibleOverviewItems(items: MarketOverviewItem[]): MarketOverviewItem[] {
  return items.filter((i) => i.value !== null);
}
