import { ISRAEL_TZ, zonedParts } from "./dateUtils";
import { ProviderFailureBreakdown, summarizeProviderFailures } from "./providerLedger";
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
  // The instant GitHub actually started the job (WORKFLOW_STARTED_AT), which
  // is BEFORE the delivery-window wait and before generation. Distinct from
  // actualStartIsrael, which is the moment generation finished and the
  // staleness guard ran.
  workflowStartedIsrael: string | null;
  reportGeneratedIsrael: string | null;
  emailSentIsrael: string | null;
  // Generation start → email sent. Excludes the delivery-window wait, so it
  // measures the pipeline itself rather than how early the cron fired.
  totalRuntimeSeconds: number | null;
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
  scanned: number;
  qualified: number;
  candidatesEvaluated: number | null;
  rejectionCounts: Record<string, number> | null;
  providerFailures: Record<string, number>;
  // Exact, recorded attribution for every unavailable field (see
  // src/providerLedger.ts) – as opposed to `providerFailures` above, which is
  // a keyword heuristic over free-text notes and is kept for continuity.
  unavailableByCause: Record<string, number>;
  unavailableByProvider: Record<string, number>;
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
  workflowStartedAtIso?: string | null;
  generationStartedAtIso?: string | null;
  // Defaults to the live ledger; injectable so tests stay deterministic.
  providerFailureBreakdown?: ProviderFailureBreakdown;
}): ReportHealth {
  const { data, timing, emailSentAtIso, workflowStartedAtIso, generationStartedAtIso } = opts;
  const breakdown = opts.providerFailureBreakdown ?? summarizeProviderFailures();
  const runtimeFrom = generationStartedAtIso ?? null;
  const totalRuntimeSeconds =
    runtimeFrom && emailSentAtIso
      ? Math.round((Date.parse(emailSentAtIso) - Date.parse(runtimeFrom)) / 1000)
      : null;
  return {
    scheduledIsrael: timing.scheduledIsraelDisplay,
    actualStartIsrael: timing.actualIsraelDisplay,
    workflowStartedIsrael: workflowStartedAtIso ? israelDisplay(workflowStartedAtIso) : null,
    reportGeneratedIsrael: israelDisplay(data.generatedAt),
    emailSentIsrael: emailSentAtIso ? israelDisplay(emailSentAtIso) : null,
    totalRuntimeSeconds,
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
    scanned: data.scanned,
    qualified: data.qualified,
    candidatesEvaluated: data.opportunityFunnel?.candidatesEvaluated ?? null,
    rejectionCounts: data.opportunityFunnel?.rejectionCounts ?? null,
    providerFailures: computeProviderFailureCounts(data.status.notes),
    unavailableByCause: breakdown.byCause,
    unavailableByProvider: breakdown.byProvider,
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
    `   Workflow started: ${h.workflowStartedIsrael ?? "n/a (not run from GitHub Actions)"}`,
    `   Report generated: ${h.reportGeneratedIsrael ?? "n/a"}`,
    `   Actual start:    ${h.actualStartIsrael} (Israel)`,
    `   Email sent:      ${h.emailSentIsrael ?? "not sent yet"}`,
    `   Total runtime:   ${h.totalRuntimeSeconds === null ? "n/a" : `${h.totalRuntimeSeconds}s`}`,
    `   Delay:           ${h.delayMinutes} min · status: ${h.timingStatus} · label: ${h.reportLabel}`,
    `   Report Quality Score: ${h.qualityScore}/100 (${h.qualityBand})`,
    `   Live: ${h.live} · Cached: ${h.cached} · Unavailable: ${h.unavailable}`,
    `   Earnings coverage:      ${h.earningsCoveragePct ?? "n/a"}%`,
    `   News coverage:          ${h.newsCoveragePct ?? "n/a"}%`,
    `   Technical coverage:     ${h.technicalCoveragePct ?? "n/a"}%`,
    `   Fundamentals coverage:  ${h.fundamentalsCoveragePct ?? "n/a"}%`,
    `   Market Overview usable metrics: ${h.marketOverviewUsableCount}`,
    `   Funnel: scanned=${h.scanned} · qualified=${h.qualified} · evaluated=${h.candidatesEvaluated ?? "n/a"}`,
    `   Top Opportunities: Normal=${h.topOpportunitiesNormal} · Reduced Confidence=${h.topOpportunitiesReduced}`,
    `   Rejection reasons: ${
      h.rejectionCounts
        ? Object.entries(h.rejectionCounts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(" · ") || "none"
        : "n/a"
    }`,
    `   Provider failures: ${Object.entries(h.providerFailures).map(([k, v]) => `${k}=${v}`).join(" · ")}`,
    `   Unavailable by cause:    ${
      Object.entries(h.unavailableByCause).map(([k, v]) => `${k}=${v}`).join(" · ") || "none"
    }`,
    `   Unavailable by provider: ${
      Object.entries(h.unavailableByProvider).map(([k, v]) => `${k}=${v}`).join(" · ") || "none"
    }`,
    `   Tracked earnings: ${h.earningsTracked}`,
    `   Awaiting results: ${h.earningsAwaiting}`,
    `   Results found: ${h.earningsResultsFound}`,
    `   Results unavailable: ${h.earningsResultsUnavailable}`,
    `   Stock reactions calculated: ${h.earningsReactionsCalculated}`,
  ];
  return lines;
}
