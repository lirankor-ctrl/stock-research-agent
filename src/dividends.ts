import { DividendInfoItem, EnrichedStock } from "./types";
import { watchlistName } from "./universe";

function displayName(s: EnrichedStock): string {
  return s.profile?.name ?? watchlistName(s.ticker) ?? s.ticker;
}

// Purely derived from company profiles already fetched this run (Alpha
// Vantage OVERVIEW) – issues zero additional API calls. Only stocks with a
// real, positive per-share dividend are included; everything else pays no
// dividend and simply doesn't belong in this section.
export function buildDividendInfo(stocks: EnrichedStock[]): DividendInfoItem[] {
  const seen = new Set<string>();
  const items: DividendInfoItem[] = [];

  for (const s of stocks) {
    if (seen.has(s.ticker)) continue;
    const dps = s.profile?.dividendPerShare;
    if (!dps || dps <= 0) continue;
    seen.add(s.ticker);
    items.push({
      ticker: s.ticker,
      name: displayName(s),
      dividendPerShare: dps,
      dividendYieldPct:
        s.profile?.dividendYield !== undefined ? s.profile.dividendYield * 100 : null,
      exDividendDate: s.profile?.exDividendDate,
      dividendDate: s.profile?.dividendDate,
    });
  }

  items.sort((a, b) => (b.dividendYieldPct ?? -1) - (a.dividendYieldPct ?? -1));
  return items;
}
