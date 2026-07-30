// Emits reports/latest.json – the machine-readable contract the Investment
// Committee prefers over Markdown. Extended with data-aware confidence and the
// agent's self-evaluation metrics so the committee can track KPIs directly.

import fs from "fs";
import path from "path";
import {
  EarningsCalendarEntry,
  EarningsCalendarStatus,
  EnrichedStock,
  MarketCatalystResult,
  MarketOverviewItem,
  RunStatus,
} from "./types";
import { Metrics, RecAction } from "./performance/types";

export interface LatestJson {
  market: "US";
  generatedAt: string;
  degraded: boolean;
  dataQuality: {
    live: number;
    cached: number;
    missing: number;
    demo: boolean;
    rateLimited: boolean;
    runScore: number; // honest, freshness-aware 0..100
    freshness: Metrics["freshness"];
  };
  opportunities: Array<{
    symbol: string;
    name?: string;
    score: number;
    price: number;
    changePct: number;
    sector?: string;
    action: RecAction;
    confidence: number; // 0..1 data-aware
    horizonDays: number;
    dataQuality: number; // 0..100 stock-level
    reasons: string[];
    risks: string[];
  }>;
  watchlist: Array<{
    symbol: string;
    price: number;
    changePct: number;
    score: number;
  }>;
  metrics: Metrics;
  notes: string[];
  // Newsletter sections (additive – safe for existing consumers to ignore).
  // Status fields carry the same "unavailable" ≠ "none found" distinction as
  // the rendered report – a machine consumer deserves the same honesty.
  earningsCalendar: EarningsCalendarEntry[];
  earningsCalendarStatus: EarningsCalendarStatus;
  marketCatalyst: MarketCatalystResult;
  marketOverview: MarketOverviewItem[];
}

export interface OpportunityWithRec {
  stock: EnrichedStock;
  action: RecAction;
  confidence: number;
  horizonDays: number;
}

export function buildLatestJson(params: {
  generatedAt: string;
  status: RunStatus;
  opportunities: OpportunityWithRec[];
  watchlist: EnrichedStock[];
  metrics: Metrics;
  earningsCalendar: EarningsCalendarEntry[];
  earningsCalendarStatus: EarningsCalendarStatus;
  marketCatalyst: MarketCatalystResult;
  marketOverview: MarketOverviewItem[];
}): LatestJson {
  const {
    generatedAt,
    status,
    opportunities,
    watchlist,
    metrics,
    earningsCalendar,
    earningsCalendarStatus,
    marketCatalyst,
    marketOverview,
  } = params;
  return {
    market: "US",
    generatedAt,
    degraded: status.rateLimitHit || status.liveCount === 0,
    dataQuality: {
      live: status.liveCount,
      cached: status.cachedCount,
      missing: status.missingCount,
      demo: false,
      rateLimited: status.rateLimitHit,
      runScore: metrics.runDataQuality,
      freshness: metrics.freshness,
    },
    opportunities: opportunities.map(({ stock, action, confidence, horizonDays }) => ({
      symbol: stock.ticker,
      name: stock.profile?.name,
      score: stock.finalScore,
      price: stock.price,
      changePct: stock.changePercent,
      sector: stock.profile?.industry || stock.profile?.sector,
      action,
      confidence,
      horizonDays,
      dataQuality: stock.dataQuality?.coverageScore ?? 0,
      reasons: [stock.longTermWhyHebrew].filter(Boolean),
      risks: [],
    })),
    watchlist: watchlist
      .filter((s) => s.price > 0)
      .map((s) => ({
        symbol: s.ticker,
        price: s.price,
        changePct: s.changePercent,
        score: s.finalScore,
      })),
    metrics,
    notes: status.notes.slice(-8),
    earningsCalendar,
    earningsCalendarStatus,
    marketCatalyst,
    marketOverview,
  };
}

export function writeLatestJson(data: LatestJson, outDir = "reports"): string {
  const fullDir = path.resolve(process.cwd(), outDir);
  if (!fs.existsSync(fullDir)) fs.mkdirSync(fullDir, { recursive: true });
  const filePath = path.join(fullDir, "latest.json");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}
