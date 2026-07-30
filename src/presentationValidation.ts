import { MIN_VISIBLE_INDICATORS, visibleOverviewItems } from "./marketOverview";
import { EMAIL_MAX_WIDTH, weekAheadExtraEarnings } from "./reportPresentation";
import { ReportData } from "./types";

export interface PresentationCheckInputs {
  data: ReportData;
  htmlAttachment: string;
  emailHtml: string;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Matches a CSS class TOKEN inside a `class="..."` attribute regardless of
// how many other classes share the attribute (e.g. `class="week-list
// week-ahead-earnings"` must still be detected as carrying
// "week-ahead-earnings") – a plain substring check on `class="foo` breaks as
// soon as "foo" isn't the first class listed.
function classTokenRegex(className: string): RegExp {
  return new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`, "g");
}

function countClassToken(html: string, className: string): number {
  return (html.match(classTokenRegex(className)) || []).length;
}

function indexOfClassToken(html: string, className: string, fromLast = false): number {
  const re = classTokenRegex(className);
  let match: RegExpExecArray | null;
  let first = -1;
  let last = -1;
  while ((match = re.exec(html)) !== null) {
    if (first === -1) first = match.index;
    last = match.index;
  }
  return fromLast ? last : first;
}

// Deterministic, string-based structural checks – no rendering/DOM required.
// Verifies the two HTML surfaces actually use the requested visual
// structure (tables/cards/tiles), not just that the data is present
// somewhere in the markup.
export function validatePresentation(inputs: PresentationCheckInputs): string[] {
  const { data, htmlAttachment, emailHtml } = inputs;
  const violations: string[] = [];

  // 1. Email has a maximum-width container (~680px).
  if (!new RegExp(`max-width:\\s*${EMAIL_MAX_WIDTH}px`).test(emailHtml)) {
    violations.push(`Email HTML body has no ~${EMAIL_MAX_WIDTH}px max-width container`);
  }

  // 2. Upcoming Earnings Calendar is displayed as structured rows, not prose.
  if (data.earningsCalendarStatus === "confirmed" && data.earningsCalendar.length > 0) {
    const expected = Math.min(12, data.earningsCalendar.length);
    if (countClassToken(htmlAttachment, "earnings-row") < expected) {
      violations.push("HTML attachment: Upcoming Earnings Calendar is not rendered as structured rows for every entry");
    }
    if (countClassToken(emailHtml, "earnings-row") < expected) {
      violations.push("Email HTML body: Upcoming Earnings Calendar is not rendered as structured rows for every entry");
    }
  }

  // 3. Market Overview is displayed as metric tiles, not one long paragraph.
  // `data-metric-value-key` is emitted exactly once per visible indicator in
  // both outputs, so an exact count is a precise, symmetric check.
  const visibleOverview = visibleOverviewItems(data.marketOverview);
  if (visibleOverview.length >= MIN_VISIBLE_INDICATORS) {
    for (const [label, html] of [
      ["HTML attachment", htmlAttachment],
      ["Email HTML body", emailHtml],
    ] as const) {
      const tileCount = countOccurrences(html, "data-metric-value-key=");
      if (tileCount < visibleOverview.length) {
        violations.push(`${label}: Market Overview is not rendered as individual metric tiles`);
      }
    }
  }

  // 4. Top Opportunities are rendered as exactly N separate cards.
  const oppCount = data.topOpportunities.length;
  if (oppCount > 0) {
    for (const [label, html] of [
      ["HTML attachment", htmlAttachment],
      ["Email HTML body", emailHtml],
    ] as const) {
      const cardCount = countClassToken(html, "opportunity-card");
      if (cardCount !== oppCount) {
        violations.push(`${label}: expected ${oppCount} Top Opportunity cards, found ${cardCount}`);
      }
    }
  }

  // 5. Data Diagnostics appears after the investment sections (after the
  // last Top Opportunity card, or after the Earnings Calendar section when
  // there are no opportunities this run).
  for (const [label, html] of [
    ["HTML attachment", htmlAttachment],
    ["Email HTML body", emailHtml],
  ] as const) {
    const diagIdx = indexOfClassToken(html, "diagnostics-card");
    const anchorIdx = oppCount > 0 ? indexOfClassToken(html, "opportunity-card", true) : html.indexOf("Upcoming Earnings Calendar");
    if (diagIdx === -1 || anchorIdx === -1 || diagIdx < anchorIdx) {
      violations.push(`${label}: Data Diagnostics does not appear after the investment sections`);
    }
  }

  // 6. Fear & Greed and VIX are never formatted as currency.
  for (const [label, html] of [
    ["HTML attachment", htmlAttachment],
    ["Email HTML body", emailHtml],
  ] as const) {
    for (const key of ["fearGreed", "vix"]) {
      const re = new RegExp(`data-metric-value-key="${key}"[^>]*>([^<]*)<`);
      const match = html.match(re);
      if (match && /\$\s*[\d.]/.test(match[1])) {
        violations.push(`${label}: "${key}" is formatted as currency (unexpected "$" prefix)`);
      }
    }
  }

  // 7. RTL direction is defined on the report container.
  for (const [label, html] of [
    ["HTML attachment", htmlAttachment],
    ["Email HTML body", emailHtml],
  ] as const) {
    if (!/dir="rtl"/.test(html)) {
      violations.push(`${label}: no dir="rtl" container found`);
    }
  }

  // 8. Obsolete duplicated "This Week To Watch" earnings content is not
  // shown when it would only repeat the Upcoming Earnings Calendar.
  if (weekAheadExtraEarnings(data).length === 0) {
    if (countClassToken(htmlAttachment, "week-ahead-earnings") > 0) {
      violations.push("HTML attachment: duplicated This Week To Watch earnings content is still shown");
    }
    if (countClassToken(emailHtml, "week-ahead-earnings") > 0) {
      violations.push("Email HTML body: duplicated This Week To Watch earnings content is still shown");
    }
  }

  return violations;
}
