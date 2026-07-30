// Shared, PURE presentation-layer helpers used by the HTML attachment and
// the HTML email body (and, for the one real formatting fix, the Markdown
// and plain-text renderers too). Nothing here changes what data is
// computed, fetched, or selected – only how already-computed values are
// labeled, grouped, or formatted for display.
import { EarningsCalendarEntry, MarketOverviewItem, OpportunityTier, ReportData, RunStatus } from "./types";

// Email clients render inside this fixed reading width; the HTML attachment
// uses a slightly narrower column for a calmer, easier-to-scan layout.
export const EMAIL_MAX_WIDTH = 680;

// One palette, reused by the attachment's <style> block (as CSS custom
// properties) and the email's inline styles (as literal hex values) so the
// two surfaces can never visually drift apart.
export const PALETTE = {
  navy: "#0f172a",
  navyAccent: "#1e3a8a",
  pageBg: "#eef2f7",
  cardBg: "#ffffff",
  border: "#e2e8f0",
  muted: "#64748b",
  mutedSoft: "#94a3b8",
  green: "#0f9d58",
  greenSoft: "#e6f4ea",
  red: "#d93025",
  redSoft: "#fce8e6",
  amber: "#b45309",
  amberSoft: "#fef3e2",
  blue: "#2563eb",
  blueSoft: "#e8f0fe",
} as const;

// ===== Market Overview value formatting =====
//
// The one genuine display-formatting BUG this pass fixes: an index/score
// (Fear & Greed, VIX) must never render with a "$" prefix – only a real
// per-share/per-unit price should. Percent-unit items (e.g. the 10-year
// Treasury yield) already render correctly via `unit === "%"`.
const NON_CURRENCY_KEYS = new Set(["fearGreed", "vix"]);

export function formatOverviewValue(item: MarketOverviewItem): string {
  if (item.value === null) return "Unavailable";
  if (item.unit === "%") return `${item.value.toFixed(2)}%`;
  if (NON_CURRENCY_KEYS.has(item.key)) {
    return item.key === "fearGreed" ? `${Math.round(item.value)}` : item.value.toFixed(2);
  }
  return `$${item.value.toFixed(2)}`;
}

// ===== Earnings-date urgency -> badge tone =====
export type DateBadgeTone = "today" | "tomorrow" | "soon" | "later";

export function earningsDateBadgeTone(daysRemaining: number): DateBadgeTone {
  if (daysRemaining <= 0) return "today";
  if (daysRemaining === 1) return "tomorrow";
  if (daysRemaining <= 3) return "soon";
  return "later";
}

export function daysRemainingLabelHebrew(daysRemaining: number): string {
  if (daysRemaining <= 0) return "היום";
  if (daysRemaining === 1) return "מחר";
  return `בעוד ${daysRemaining} ימים`;
}

// ===== Fear & Greed banding -> tone (shared by the header badge and the
// Market Overview gauge, so the two never disagree). =====
export type SentimentTone = "extreme-fear" | "fear" | "neutral" | "greed" | "extreme-greed";

export function sentimentTone(score: number): SentimentTone {
  if (score < 25) return "extreme-fear";
  if (score < 45) return "fear";
  if (score <= 55) return "neutral";
  if (score < 75) return "greed";
  return "extreme-greed";
}

// ===== Opportunity tier -> a coarse, presentation-only "risk level" label.
// Derived from the tier the categorizer already assigned during scoring –
// this introduces no new classification, just a display label for the
// existing one. =====
export function riskLevelHebrew(tier: OpportunityTier): string {
  switch (tier) {
    case "core":
      return "סיכון נמוך";
    case "growth":
      return "סיכון בינוני";
    case "speculative":
      return "סיכון גבוה";
    default:
      return "לא זמין";
  }
}

// ===== Header "data freshness" line – same counters already shown in Data
// Diagnostics, just surfaced once more, compactly, at the top. =====
export function dataFreshnessLine(status: RunStatus): string {
  return `${status.liveCount} Live · ${status.cachedCount} Cached · ${status.missingCount} Unavailable`;
}

// ===== Market catalyst "why it matters" – a short, generic, template
// sentence built ONLY from fields already on the catalyst (ticker); it
// asserts no new fact and fabricates no analysis, it simply gives the
// highlighted card a one-line explanation as requested. =====
export function catalystWhyItMattersHebrew(ticker: string): string {
  return `דיווח הרווחים של ${ticker} עשוי להניע תנודתיות משמעותית במניה ובסנטימנט הסקטור הרחב.`;
}

// ===== "This Week To Watch" de-duplication =====
//
// weekAhead.earnings is a same-source subset of earningsCalendar (both come
// from the same Nasdaq lookup). Whatever entries already appear in the
// rendered Upcoming Earnings Calendar (its visible, capped slice) carry zero
// additional information here – only entries NOT already shown there are
// genuinely new information worth a second mention.
export function weekAheadExtraEarnings(data: ReportData): EarningsCalendarEntry[] {
  const shown = new Set(data.earningsCalendar.slice(0, 12).map((e) => `${e.ticker}:${e.reportDate}`));
  return data.weekAhead.earnings.filter((e) => !shown.has(`${e.ticker}:${e.reportDate}`));
}

// ===== RTL/LTR mixed-content helper =====
//
// Wraps already-escaped ticker/price/percent/date/English-headline text so
// it renders left-to-right and doesn't get visually reordered when embedded
// inline inside RTL Hebrew paragraph flow.
export function ltr(escapedHtml: string): string {
  return `<span dir="ltr" style="unicode-bidi:isolate;">${escapedHtml}</span>`;
}

// Same as `ltr`, but also carries a caller-supplied attribute string – used
// to tag the Market Overview value elements unambiguously (distinct from
// the tile's outer `data-metric-key` container) so presentation validation
// can check the FORMATTED VALUE text itself, e.g. that Fear & Greed / VIX
// never render with a "$" prefix.
export function ltrTagged(escapedHtml: string, attrs: string): string {
  return `<span dir="ltr" ${attrs} style="unicode-bidi:isolate;">${escapedHtml}</span>`;
}
