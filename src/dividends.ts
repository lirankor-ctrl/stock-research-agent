import { DividendInfoItem, DividendsStatus, EnrichedStock } from "./types";
import { watchlistName } from "./universe";

function displayName(s: EnrichedStock): string {
  return s.profile?.name ?? watchlistName(s.ticker) ?? s.ticker;
}

export interface DividendInfoResult {
  items: DividendInfoItem[];
  // "confirmed": we had a real profile (live or cached) for at least one
  // stock, so an empty list truly means none of them pay a dividend.
  // "unavailable": every profile fetch failed – we don't know either way,
  // and must say so instead of falsely claiming "no dividends".
  status: DividendsStatus;
}

// Purely derived from company profiles already fetched this run (Alpha
// Vantage OVERVIEW) – issues zero additional API calls. Only stocks with a
// real, positive per-share dividend are included; everything else pays no
// dividend and simply doesn't belong in this section – UNLESS we never
// actually got a profile for any of them, in which case "no dividend" would
// be a fabricated claim rather than an observed fact.
export function buildDividendInfo(stocks: EnrichedStock[]): DividendInfoResult {
  const seen = new Set<string>();
  const items: DividendInfoItem[] = [];
  let anyProfileAvailable = false;

  for (const s of stocks) {
    if (seen.has(s.ticker)) continue;
    if (s.profileSource.source !== "unavailable") anyProfileAvailable = true;
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
  return { items, status: items.length > 0 || anyProfileAvailable ? "confirmed" : "unavailable" };
}
