import { passesPreFilter } from "./filters";
import { classifyByTicker } from "./sectors";
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
    preScore: 0,
  };
}

function preScore(stock: Stock): number {
  const absMove = Math.abs(stock.changePercent);
  const volumeScore = Math.log10(Math.max(stock.volume, 1));
  let score = absMove * 1.0 + volumeScore * 5;

  if (stock.category === "gainer") score *= 1.15;
  if (stock.category === "active") score *= 1.05;
  if (stock.category === "loser") score *= 0.95;

  if (classifyByTicker(stock.ticker)) score *= 1.4;

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
