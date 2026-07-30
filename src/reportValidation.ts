import { computeReportFingerprint, extractFingerprint } from "./reportFingerprint";
import { ReportData } from "./types";

export interface ConsistencyCheckInputs {
  data: ReportData;
  htmlAttachment: string;
  mdAttachment: string;
  emailHtml: string;
  emailText: string;
}

// Headings from the old, independently-hand-rolled email.ts template. If any
// of these ever reappear in a rendered email, something regressed back to
// the duplicated-template bug this refactor fixes.
const OBSOLETE_HEADINGS = [
  "Market Sentiment",
  "Core Opportunities",
  "Growth Opportunities",
  "Speculative Opportunity",
];

// Deterministic – same inputs always produce the same violations, no network,
// no timing dependence. Returns an empty array when everything is consistent.
export function validateReportConsistency(inputs: ConsistencyCheckInputs): string[] {
  const { data, htmlAttachment, mdAttachment, emailHtml, emailText } = inputs;
  const violations: string[] = [];

  for (const heading of OBSOLETE_HEADINGS) {
    if (emailHtml.includes(heading)) {
      violations.push(`Email HTML body still contains the obsolete heading "${heading}"`);
    }
    if (emailText.includes(heading)) {
      violations.push(`Email text body still contains the obsolete heading "${heading}"`);
    }
  }

  if (data.earningsCalendarStatus === "confirmed" && data.earningsCalendar.length > 0) {
    const ticker = data.earningsCalendar[0].ticker;
    if (!htmlAttachment.includes(ticker)) {
      violations.push(`Upcoming Earnings Calendar entry "${ticker}" is missing from the HTML attachment`);
    }
    if (!mdAttachment.includes(ticker)) {
      violations.push(`Upcoming Earnings Calendar entry "${ticker}" is missing from the Markdown attachment`);
    }
    if (!emailHtml.includes(ticker)) {
      violations.push(`Upcoming Earnings Calendar entry "${ticker}" is missing from the email HTML body`);
    }
    if (!emailText.includes(ticker)) {
      violations.push(`Upcoming Earnings Calendar entry "${ticker}" is missing from the email text body`);
    }
  }

  for (const s of data.topOpportunities) {
    if (!htmlAttachment.includes(s.ticker)) {
      violations.push(`Top Opportunity "${s.ticker}" is missing from the HTML attachment`);
    }
    if (!emailHtml.includes(s.ticker)) {
      violations.push(`Top Opportunity "${s.ticker}" is missing from the email HTML body – email and attachment use different opportunity lists`);
    }
  }

  const expectedFingerprint = computeReportFingerprint(data);
  const outputs: Array<[string, string]> = [
    ["HTML attachment", htmlAttachment],
    ["Markdown attachment", mdAttachment],
    ["Email HTML body", emailHtml],
    ["Email text body", emailText],
  ];
  for (const [label, rendered] of outputs) {
    const found = extractFingerprint(rendered);
    if (found === null) {
      violations.push(`${label} has no report-data fingerprint embedded – cannot verify it came from this run's ReportData`);
    } else if (found !== expectedFingerprint) {
      violations.push(
        `${label} fingerprint (${found}) does not match the current ReportData (${expectedFingerprint}) – it was generated from a different report-data object`
      );
    }
  }

  return violations;
}
