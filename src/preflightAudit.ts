import { EarningsCalendarStatus } from "./types";

// A single section's data-investigation result: did we end up with usable
// coverage (live, cached, or locally computed), or did every avenue fail?
export interface SectionCoverage {
  label: string;
  ok: boolean;
  detail: string;
}

export interface PreflightAudit {
  sections: SectionCoverage[];
  coveragePct: number; // 0-100, share of sections that came back OK
  emergencyMode: boolean;
}

// Below this overall coverage, the run is treated as a poor-data-quality day
// and recovery (relaxing thresholds rather than rendering empty sections) is
// attempted before the report is generated.
const EMERGENCY_THRESHOLD_PCT = 50;

function ratioOk(have: number, total: number): boolean {
  return total === 0 || have / total >= 0.5;
}

export interface PreflightInput {
  moversAvailable: boolean;
  watchlistUsable: number; // live + cached quotes
  watchlistTotal: number;
  technicalsAvailable: number;
  technicalsTotal: number;
  earningsCalendarStatus: EarningsCalendarStatus;
  marketOverviewWithValue: number;
  marketOverviewTotal: number;
  fearGreedAvailable: boolean;
  topOpportunitiesCount: number;
}

// Runs the Data Investigation phase's final rollup: what actually came
// through, section by section, and whether the overall run is degraded
// enough to warrant automatic recovery before rendering.
export function buildPreflightAudit(input: PreflightInput): PreflightAudit {
  const sections: SectionCoverage[] = [
    {
      label: "Movers (universe)",
      ok: input.moversAvailable,
      detail: input.moversAvailable ? "available" : "unavailable (live + cache exhausted)",
    },
    {
      label: "Watchlist quotes",
      ok: ratioOk(input.watchlistUsable, input.watchlistTotal),
      detail: `${input.watchlistUsable}/${input.watchlistTotal} usable`,
    },
    {
      label: "Technicals (RSI/Bollinger, local calc)",
      ok: ratioOk(input.technicalsAvailable, input.technicalsTotal),
      detail: `${input.technicalsAvailable}/${input.technicalsTotal} computed`,
    },
    {
      label: "Earnings calendar",
      ok: input.earningsCalendarStatus !== "unavailable",
      detail: input.earningsCalendarStatus,
    },
    {
      label: "Market overview",
      ok: ratioOk(input.marketOverviewWithValue, input.marketOverviewTotal),
      detail: `${input.marketOverviewWithValue}/${input.marketOverviewTotal} with a value`,
    },
    {
      label: "Fear & Greed",
      ok: input.fearGreedAvailable,
      detail: input.fearGreedAvailable ? "available" : "unavailable",
    },
    {
      label: "Top Opportunities",
      ok: input.topOpportunitiesCount > 0,
      detail: `${input.topOpportunitiesCount}/3`,
    },
  ];

  const coveragePct = Math.round(
    (sections.filter((s) => s.ok).length / sections.length) * 100
  );

  return { sections, coveragePct, emergencyMode: coveragePct < EMERGENCY_THRESHOLD_PCT };
}

export function formatPreflightAudit(audit: PreflightAudit): string[] {
  const lines = [
    `🛫 Preflight Quality Audit — coverage ${audit.coveragePct}%` +
      (audit.emergencyMode ? " ⚠️  EMERGENCY REPORT MODE" : ""),
  ];
  for (const s of audit.sections) {
    lines.push(`   ${s.ok ? "✅" : "⚠️ "} ${s.label}: ${s.detail}`);
  }
  return lines;
}
