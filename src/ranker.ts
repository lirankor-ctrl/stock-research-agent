import { passesPreFilter } from "./filters";
import { classifyByTicker } from "./sectors";
import { isIndexMember } from "./universe";
import {
  AlphaVantageMoversResponse,
  RawMover,
  Stock,
  StockCategory,
} from "./types";

function parseMover(raw: RawMover, category: StockCategory): Stock | null {
  if (!passesPreFilter(raw)) return null;

  const price = parseFloat(raw.price);
  const changePercent = parseFloat(
    (raw.change_percentage || "").replace("%", "")
  );
  const volume = parseInt(raw.volume, 10);

  if (Number.isNaN(price) || Number.isNaN(changePercent) || Number.isNaN(volume)) {
    return null;
  }

  return {
    ticker: raw.ticker.toUpperCase(),
    price,
    changePercent,
    volume,
    category,
    origin: "mover",
    preScore: 0,
  };
}

// Pre-score decides which movers are worth spending an API call to enrich.
// For a long-term report we prioritise liquid, established, index-member names
// with moderate moves – and actively deprioritise extreme daily swings.
function preScore(stock: Stock): number {
  const absMove = Math.abs(stock.changePercent);
  const volumeScore = Math.log10(Math.max(stock.volume, 1));

  let score = volumeScore * 6;

  // Moderate moves are fine; extreme moves are a red flag, not a feature.
  if (absMove <= 15) score += absMove * 0.5;
  else if (absMove <= 40) score += 7.5 - (absMove - 15) * 0.2;
  else score -= (absMove - 40) * 0.5;

  if (isIndexMember(stock.ticker)) score *= 1.6;
  else if (classifyByTicker(stock.ticker)) score *= 1.3;

  if (stock.category === "active") score *= 1.1; // liquidity signal

  return score;
}

export interface PreRanked {
  all: Stock[];               // filtered + pre-scored, sorted desc
  gainers: Stock[];
  losers: Stock[];
  active: Stock[];
  rawCounts: { gainers: number; losers: number; active: number };
}

export function preRank(data: AlphaVantageMoversResponse): PreRanked {
  const rawCounts = {
    gainers: data.top_gainers?.length ?? 0,
    losers: data.top_losers?.length ?? 0,
    active: data.most_actively_traded?.length ?? 0,
  };

  const gainers: Stock[] = [];
  const losers: Stock[] = [];
  const active: Stock[] = [];

  for (const r of data.top_gainers ?? []) {
    const s = parseMover(r, "gainer");
    if (s) gainers.push(s);
  }
  for (const r of data.top_losers ?? []) {
    const s = parseMover(r, "loser");
    if (s) losers.push(s);
  }
  for (const r of data.most_actively_traded ?? []) {
    const s = parseMover(r, "active");
    if (s) active.push(s);
  }

  // Dedup keeping the highest-pre-score instance per ticker
  const byTicker = new Map<string, Stock>();
  for (const s of [...gainers, ...losers, ...active]) {
    s.preScore = preScore(s);
    const existing = byTicker.get(s.ticker);
    if (!existing || s.preScore > existing.preScore) {
      byTicker.set(s.ticker, s);
    }
  }
  const all = Array.from(byTicker.values()).sort(
    (a, b) => b.preScore - a.preScore
  );

  return { all, gainers, losers, active, rawCounts };
}
