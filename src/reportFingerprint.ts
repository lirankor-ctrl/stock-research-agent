import { createHash } from "crypto";
import { ReportData } from "./types";

// A single, deterministic fingerprint of everything that ends up on screen –
// used to prove the HTML attachment, Markdown attachment, HTML email body and
// plain-text email body were all rendered from the exact same ReportData
// object in the same run, never four independently-decided views of it.
export function computeReportFingerprint(data: ReportData): string {
  const shape = {
    topOpportunities: data.topOpportunities.map((s) => s.ticker),
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
