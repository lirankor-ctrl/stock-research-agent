import { createHash } from "crypto";
import { ReportData } from "./types";

// A single, deterministic fingerprint of everything that ends up on screen –
// used to prove the HTML attachment, Markdown attachment, HTML email body and
// plain-text email body were all rendered from the exact same ReportData
// object in the same run, never four independently-decided views of it.
export function computeReportFingerprint(data: ReportData): string {
  const shape = {
    generatedAt: data.generatedAt,
    reportQualityScore: data.reportQuality.score,
    topOpportunities: data.topOpportunities.map((s) => s.ticker),
    emergencyWatch: data.emergencyWatch.map((s) => s.ticker),
    watchlist: data.watchlist.map((s) => s.ticker),
    earningsCalendar: data.earningsCalendar.map((e) => `${e.ticker}:${e.reportDate}`),
    earningsCalendarStatus: data.earningsCalendarStatus,
    marketCatalyst: data.marketCatalyst.catalyst
      ? `${data.marketCatalyst.catalyst.ticker}:${data.marketCatalyst.catalyst.reportDate}`
      : data.marketCatalyst.status,
    marketOverview: data.marketOverview.map((i) => `${i.key}:${i.value}`),
    technicalWatch: data.technicalWatch.map((i) => i.ticker),
    earningsFollowUp: data.earningsFollowUp.entries.map((e) => `${e.ticker}:${e.reportDate}`),
    dividends: data.dividends.map((d) => d.ticker),
    marketStory: data.marketStory?.ticker ?? null,
    additionalHeadlines: data.additionalHeadlines.map((h) => h.ticker),
    status: {
      live: data.status.liveCount,
      cached: data.status.cachedCount,
      missing: data.status.missingCount,
    },
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

const MARKER = "REPORT-FINGERPRINT";
const EXTRACT_RE = new RegExp(`${MARKER}:([0-9a-f]{16})`);

// HTML/Markdown-safe – renders as an invisible comment in both.
export function fingerprintHtmlComment(data: ReportData): string {
  return `<!-- ${MARKER}:${computeReportFingerprint(data)} -->`;
}

// Plain-text-safe – a short, low-key tag for the footer.
export function fingerprintTextTag(data: ReportData): string {
  return `[${MARKER}:${computeReportFingerprint(data)}]`;
}

export function extractFingerprint(rendered: string): string | null {
  const m = rendered.match(EXTRACT_RE);
  return m ? m[1] : null;
}

// ===== Human-readable provenance tag =====
//
// Unlike the opaque hash above, this is deliberately readable at a glance –
// the four fields most likely to visibly diverge if one renderer were ever
// fed stale or different data (exactly the failure mode reported: an email
// showing "no earnings" and an old catalyst while the HTML attachment,
// rendered from the SAME run, showed real ones). Embedded in every one of
// the four outputs; validateReportConsistency asserts all four are
// byte-identical.
export interface ReportProvenance {
  reportDate: string; // YYYY-MM-DD, from generatedAt – never a fresh `new Date()`
  earningsCount: number;
  reportQualityScore: number;
  firstOpportunityTicker: string; // topOpportunities[0], else emergencyWatch[0], else "NONE"
}

export function computeProvenance(data: ReportData): ReportProvenance {
  return {
    reportDate: data.generatedAt.slice(0, 10),
    earningsCount: data.earningsCalendar.length,
    reportQualityScore: data.reportQuality.score,
    firstOpportunityTicker: data.topOpportunities[0]?.ticker ?? data.emergencyWatch[0]?.ticker ?? "NONE",
  };
}

const PROVENANCE_MARKER = "REPORT-PROVENANCE";
// [^\s\]]+ (not \S+) so the plain-text tag's closing "]" – e.g.
// "[REPORT-PROVENANCE:...]" – is never swallowed into the captured value.
const PROVENANCE_RE = new RegExp(`${PROVENANCE_MARKER}:([^\\s\\]]+)`);

function formatProvenanceTag(data: ReportData): string {
  const p = computeProvenance(data);
  return `${PROVENANCE_MARKER}:date=${p.reportDate}|earnings=${p.earningsCount}|quality=${p.reportQualityScore}|firstOpp=${p.firstOpportunityTicker}`;
}

// HTML/Markdown-safe – renders as an invisible comment in both.
export function provenanceHtmlComment(data: ReportData): string {
  return `<!-- ${formatProvenanceTag(data)} -->`;
}

// Plain-text-safe – a short, low-key tag for the footer.
export function provenanceTextTag(data: ReportData): string {
  return `[${formatProvenanceTag(data)}]`;
}

export function extractProvenance(rendered: string): string | null {
  const m = rendered.match(PROVENANCE_RE);
  return m ? m[1] : null;
}
