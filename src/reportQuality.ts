import { EarningsCalendarStatus } from "./types";

// ===== Report Quality Score =====
//
// A single 0-100 number, printed in diagnostics before every report, that
// answers "how good is today's report, really?" across the dimensions that
// actually matter to a reader: can we show upcoming earnings, market data,
// our own watchlist's prices, technicals, news, fundamentals, and did we
// land on genuinely confident Top Opportunities?
//
//   90-100  Excellent
//   75-89   Good
//   60-74   Reduced
//   <60     Poor
//
// Below RECOVERY_THRESHOLD, pipeline.ts attempts one concrete recovery
// action (widening the Market Story news window) and recomputes. Below
// SEND_THRESHOLD even after recovery, the normal newsletter is replaced by
// a short diagnostic report instead – see reportGenerator.ts /
// htmlReportGenerator.ts / emailBodyGenerator.ts's generateDiagnostic*
// functions. This module only SCORES; the recovery action itself lives in
// pipeline.ts because it needs live access to the fetch functions.
export type QualityBand = "Excellent" | "Good" | "Reduced" | "Poor";

export interface QualityDimension {
  key: string;
  label: string;
  scorePct: number; // 0-100
  detail: string;
}

export interface ReportQuality {
  dimensions: QualityDimension[];
  score: number; // 0-100, equal-weighted average of the dimensions
  band: QualityBand;
}

export const RECOVERY_THRESHOLD = 75;
export const SEND_THRESHOLD = 60;

export function qualityBand(score: number): QualityBand {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Good";
  if (score >= 60) return "Reduced";
  return "Poor";
}

function ratioPct(have: number, total: number): number {
  if (total <= 0) return 100; // nothing to assess -> not a quality problem
  return Math.round((have / total) * 100);
}

export interface ReportQualityInput {
  earningsCalendarStatus: EarningsCalendarStatus;
  marketOverviewWithValue: number;
  marketOverviewTotal: number;
  watchlistPriceUsable: number;
  watchlistTotal: number;
  technicalsAvailable: number;
  technicalsTotal: number;
  newsAvailableCount: number; // watchlist+topOpp stocks with a usable (live/cached) news fetch
  newsTotal: number;
  fundamentalsAvailableCount: number; // watchlist+topOpp stocks with a usable (live/cached) profile fetch
  fundamentalsTotal: number;
  topOpportunitiesConfidence: number[]; // confidenceScore of each Top Opportunity
  emergencyWatchCount: number;
  // Earnings follow-up tracker (src/earningsTracker.ts) – of the tracked
  // events whose expected date has passed (i.e. we actually attempted to
  // resolve them), how many got real actual results vs. genuinely couldn't
  // be confirmed. "awaiting" (not yet due) is deliberately excluded from
  // both sides – it isn't a coverage failure, just not due yet.
  earningsFollowUpResultsFound: number;
  earningsFollowUpResultsUnavailable: number;
}

export function computeReportQuality(input: ReportQualityInput): ReportQuality {
  // "unavailable" is the only earnings-calendar outcome that reflects a real
  // failure – "confirmed" and "noneFound" both mean we successfully reached
  // the data and got a real answer, good or empty.
  const earningsScore = input.earningsCalendarStatus === "unavailable" ? 0 : 100;

  let topOppScore: number;
  let topOppDetail: string;
  if (input.topOpportunitiesConfidence.length > 0) {
    topOppScore = Math.round(
      input.topOpportunitiesConfidence.reduce((a, b) => a + b, 0) / input.topOpportunitiesConfidence.length
    );
    topOppDetail = `avg confidence ${topOppScore}`;
  } else if (input.emergencyWatchCount > 0) {
    topOppScore = 40; // found candidates, but only reduced-confidence ones
    topOppDetail = "Emergency Watch only";
  } else {
    topOppScore = 60; // genuinely nothing qualified today - not by itself a data failure
    topOppDetail = "none qualified";
  }

  const dimensions: QualityDimension[] = [
    {
      key: "earningsCalendar",
      label: "Earnings calendar coverage",
      scorePct: earningsScore,
      detail: input.earningsCalendarStatus,
    },
    {
      key: "marketData",
      label: "Market data coverage",
      scorePct: ratioPct(input.marketOverviewWithValue, input.marketOverviewTotal),
      detail: `${input.marketOverviewWithValue}/${input.marketOverviewTotal}`,
    },
    {
      key: "watchlistPrice",
      label: "Watchlist price coverage",
      scorePct: ratioPct(input.watchlistPriceUsable, input.watchlistTotal),
      detail: `${input.watchlistPriceUsable}/${input.watchlistTotal}`,
    },
    {
      key: "technical",
      label: "Technical coverage",
      scorePct: ratioPct(input.technicalsAvailable, input.technicalsTotal),
      detail: `${input.technicalsAvailable}/${input.technicalsTotal}`,
    },
    {
      key: "news",
      label: "News coverage",
      scorePct: ratioPct(input.newsAvailableCount, input.newsTotal),
      detail: `${input.newsAvailableCount}/${input.newsTotal}`,
    },
    {
      key: "fundamentals",
      label: "Fundamentals coverage",
      scorePct: ratioPct(input.fundamentalsAvailableCount, input.fundamentalsTotal),
      detail: `${input.fundamentalsAvailableCount}/${input.fundamentalsTotal}`,
    },
    {
      key: "topOpportunityConfidence",
      label: "Top Opportunity confidence",
      scorePct: topOppScore,
      detail: topOppDetail,
    },
    {
      key: "earningsFollowUp",
      label: "Earnings follow-up coverage",
      scorePct: ratioPct(input.earningsFollowUpResultsFound, input.earningsFollowUpResultsFound + input.earningsFollowUpResultsUnavailable),
      detail: `${input.earningsFollowUpResultsFound}/${input.earningsFollowUpResultsFound + input.earningsFollowUpResultsUnavailable}`,
    },
  ];

  const score = Math.round(dimensions.reduce((a, d) => a + d.scorePct, 0) / dimensions.length);
  return { dimensions, score, band: qualityBand(score) };
}

// ===== Named send-gate checks =====
//
// The score above is an equal-weighted AVERAGE across dimensions (by
// design – see the module comment), so a single weak dimension can be
// diluted by strong ones elsewhere. This function makes four specific,
// named conditions visible in diagnostics even when the averaged score
// alone wouldn't have flagged them: "Do not send a normal report unless
// Market Overview has >=6 usable metrics, the earnings calendar has valid
// provider status, technical coverage is >=70%, and the overall score is
// >=RECOVERY_THRESHOLD." This is diagnostic/logging only – it does NOT
// change the normal-vs-diagnostic send decision (still purely
// score < SEND_THRESHOLD, see pipeline.ts), so a report that's strong
// everywhere else but weak on one named dimension still sends rather than
// being blocked by a single soft signal, consistent with the averaged-score
// design used everywhere else in this module.
export interface SendGateResult {
  ok: boolean;
  reasons: string[]; // failing conditions only, empty when ok
}

export const MIN_MARKET_OVERVIEW_METRICS = 6;
export const MIN_TECHNICAL_COVERAGE_PCT = 70;

export function evaluateSendGate(input: {
  marketOverviewUsableCount: number;
  earningsCalendarStatus: EarningsCalendarStatus;
  technicalsAvailable: number;
  technicalsTotal: number;
  score: number;
}): SendGateResult {
  const reasons: string[] = [];
  if (input.marketOverviewUsableCount < MIN_MARKET_OVERVIEW_METRICS) {
    reasons.push(
      `Market Overview has only ${input.marketOverviewUsableCount} usable metrics (need >=${MIN_MARKET_OVERVIEW_METRICS})`
    );
  }
  if (input.earningsCalendarStatus === "unavailable") {
    reasons.push("Earnings calendar provider status is unavailable");
  }
  const technicalPct = input.technicalsTotal > 0 ? (input.technicalsAvailable / input.technicalsTotal) * 100 : 100;
  if (technicalPct < MIN_TECHNICAL_COVERAGE_PCT) {
    reasons.push(`Technical coverage ${technicalPct.toFixed(0)}% is below ${MIN_TECHNICAL_COVERAGE_PCT}%`);
  }
  if (input.score < RECOVERY_THRESHOLD) {
    reasons.push(`Report Quality Score ${input.score} is below ${RECOVERY_THRESHOLD}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function formatSendGate(g: SendGateResult): string[] {
  if (g.ok) return [`   ✅ Send gate: all named conditions pass (Market Overview, earnings status, technical coverage, quality score).`];
  return [
    `   ⚠️  Send gate: ${g.reasons.length} named condition(s) not fully met (informational – see score/band above for the actual send decision):`,
    ...g.reasons.map((r) => `      - ${r}`),
  ];
}

export function formatReportQuality(q: ReportQuality): string[] {
  const lines = [`🛫 Report Quality Score: ${q.score}/100 (${q.band})`];
  for (const d of q.dimensions) {
    const mark = d.scorePct >= 75 ? "✅" : d.scorePct >= 50 ? "⚠️ " : "🔴";
    lines.push(`   ${mark} ${d.label}: ${d.scorePct}% (${d.detail})`);
  }
  return lines;
}
