import { ISRAEL_TZ, zonedParts } from "./dateUtils";
import { ReportQuality } from "./reportQuality";
import { ReportTimingResult } from "./reportTiming";
import { ReportData } from "./types";

// ===== Report Health Summary =====
//
// A single, always-logged block that answers "was this run on time, and was
// it any good?" in one place — the exact set of facts an operator needed on
// 2026-08-28 to see immediately that something was wrong (a report that
// arrived at 02:04 IDT with an empty Top Opportunities section) instead of
// discovering it from a confused reader.

function israelDisplay(iso: string): string {
  const p = zonedParts(new Date(iso), ISRAEL_TZ);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (Israel)`;
}

function dimPct(quality: ReportQuality, key: string): number | null {
  return quality.dimensions.find((d) => d.key === key)?.scorePct ?? null;
}

// Best-effort, keyword-based attribution over the free-text provider notes
// already collected in RunStatus.notes during the run. Not a structural
// refactor of every fetch call – reuses what's already logged so this stays
// cheap and low-risk, at the cost of being a heuristic rather than an exact
// per-call ledger.
export function computeProviderFailureCounts(notes: string[]): Record<string, number> {
  const counts: Record<string, number> = { alphaVantage: 0, yahoo: 0, nasdaqFinnhub: 0, other: 0 };
  for (const raw of notes) {
    const n = raw.toLowerCase();
    const isFailureNote = n.includes("rate limit") || n.includes("error") || n.includes("unavailable");
    if (!isFailureNote) continue;
    if (n.includes("yahoo")) counts.yahoo++;
    else if (n.includes("nasdaq") || n.includes("finnhub")) counts.nasdaqFinnhub++;
    else if (
      n.includes("quote_") || n.includes("overview_") || n.includes("news_") ||
      n.includes("econ_") || n.includes("movers") || n.includes("alpha")
    ) {
      counts.alphaVantage++;
    } else {
      counts.other++;
    }
  }
  return counts;
}

export interface ReportHealth {
  scheduledIsrael: string;
  actualStartIsrael: string;
  emailSentIsrael: string | null;
  delayMinutes: number;
  timingStatus: string;
  reportLabel: string;
  qualityScore: number;
  qualityBand: string;
  live: number;
  cached: number;
  unavailable: number;
  earningsCoveragePct: number | null;
  newsCoveragePct: number | null;
  technicalCoveragePct: number | null;
  fundamentalsCoveragePct: number | null;
  marketOverviewUsableCount: number;
  topOpportunitiesNormal: number;
  topOpportunitiesReduced: number;
  providerFailures: Record<string, number>;
  // Earnings follow-up tracker (src/earningsTracker.ts) – section 8.
  earningsTracked: number;
  earningsAwaiting: number;
  earningsResultsFound: number;
  earningsResultsUnavailable: number;
  earningsReactionsCalculated: number;
}

export function buildReportHealth(opts: {
  data: ReportData;
  timing: ReportTimingResult;
  emailSentAtIso: string | null;
}): ReportHealth {
  const { data, timing, emailSentAtIso } = opts;
  return {
    scheduledIsrael: timing.scheduledIsraelDisplay,
    actualStartIsrael: timing.actualIsraelDisplay,
    emailSentIsrael: emailSentAtIso ? israelDisplay(emailSentAtIso) : null,
    delayMinutes: timing.delayMinutes,
    timingStatus: timing.status,
    reportLabel: timing.reportLabel,
    qualityScore: data.reportQuality.score,
    qualityBand: data.reportQuality.band,
    live: data.status.liveCount,
    cached: data.status.cachedCount,
    unavailable: data.status.missingCount,
    earningsCoveragePct: dimPct(data.reportQuality, "earningsCalendar"),
    newsCoveragePct: dimPct(data.reportQuality, "news"),
    technicalCoveragePct: dimPct(data.reportQuality, "technical"),
    fundamentalsCoveragePct: dimPct(data.reportQuality, "fundamentals"),
    marketOverviewUsableCount: data.marketOverview.filter((i) => i.value !== null).length,
    topOpportunitiesNormal: data.topOpportunities.length,
    topOpportunitiesReduced: data.emergencyWatch.length,
    providerFailures: computeProviderFailureCounts(data.status.notes),
    earningsTracked: data.earningsFollowUp.coverage.tracked,
    earningsAwaiting: data.earningsFollowUp.coverage.awaiting,
    earningsResultsFound: data.earningsFollowUp.coverage.resultsFound,
    earningsResultsUnavailable: data.earningsFollowUp.coverage.resultsUnavailable,
    earningsReactionsCalculated: data.earningsFollowUp.coverage.reactionsCalculated,
  };
}

export function formatReportHealth(h: ReportHealth): string[] {
  const lines = [
    "🩺 REPORT HEALTH",
    `   Scheduled time:  ${h.scheduledIsrael} (Israel)`,
    `   Actual start:    ${h.actualStartIsrael} (Israel)`,
    `   Email sent:      ${h.emailSentIsrael ?? "not sent yet"}`,
    `   Delay:           ${h.delayMinutes} min · status: ${h.timingStatus} · label: ${h.reportLabel}`,
    `   Report Quality Score: ${h.qualityScore}/100 (${h.qualityBand})`,
    `   Live: ${h.live} · Cached: ${h.cached} · Unavailable: ${h.unavailable}`,
    `   Earnings coverage:      ${h.earningsCoveragePct ?? "n/a"}%`,
    `   News coverage:          ${h.newsCoveragePct ?? "n/a"}%`,
    `   Technical coverage:     ${h.technicalCoveragePct ?? "n/a"}%`,
    `   Fundamentals coverage:  ${h.fundamentalsCoveragePct ?? "n/a"}%`,
    `   Market Overview usable metrics: ${h.marketOverviewUsableCount}`,
    `   Top Opportunities: Normal=${h.topOpportunitiesNormal} · Reduced Confidence=${h.topOpportunitiesReduced}`,
    `   Provider failures: ${Object.entries(h.providerFailures).map(([k, v]) => `${k}=${v}`).join(" · ")}`,
    `   Tracked earnings: ${h.earningsTracked}`,
    `   Awaiting results: ${h.earningsAwaiting}`,
    `   Results found: ${h.earningsResultsFound}`,
    `   Results unavailable: ${h.earningsResultsUnavailable}`,
    `   Stock reactions calculated: ${h.earningsReactionsCalculated}`,
  ];
  return lines;
}
