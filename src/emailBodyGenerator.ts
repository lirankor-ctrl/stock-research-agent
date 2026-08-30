// Renders the HTML and plain-text email BODY from the exact same ReportData
// object used for the HTML/Markdown attachments (see reportGenerator.ts /
// htmlReportGenerator.ts). Sections here MUST mirror those files' section
// set and order — this file only decides HOW to lay it out for an email
// client (inline styles, table-based layout, no flexbox/grid, no JS), never
// WHICH data to show.
import { earningsCalendarStatusMessageHebrew } from "./earningsCalendar";
import { earningsFollowUpStatusMessageHebrew } from "./earningsFollowUp";
import { EMERGENCY_MODE_LABEL, EMERGENCY_MODE_EXPLANATION_HEBREW } from "./emergencyMode";
import { marketCatalystStatusMessageHebrew } from "./marketCatalyst";
import { MIN_VISIBLE_INDICATORS, visibleOverviewItems } from "./marketOverview";
import { FALLBACK_NOTICE } from "./marketStory";
import {
  fingerprintHtmlComment,
  fingerprintTextTag,
  provenanceHtmlComment,
  provenanceTextTag,
} from "./reportFingerprint";
import {
  catalystWhyItMattersHebrew,
  dataFreshnessLine,
  daysRemainingLabelHebrew,
  earningsDateBadgeTone,
  EMAIL_MAX_WIDTH,
  formatOverviewValue,
  ltr,
  ltrTagged,
  PALETTE,
  riskLevelHebrew,
  sentimentTone,
  weekAheadExtraEarnings,
} from "./reportPresentation";
import { displayName, fmtChange, fmtPrice } from "./reportGenerator";
import { rsiInterpretation } from "./technicals";
import {
  DividendInfoItem,
  DividendsStatus,
  EarningsCalendarEntry,
  EarningsFollowUpResult,
  EnrichedStock,
  MarketCatalystResult,
  MarketOverviewItem,
  MarketStory,
  OpportunityThesis,
  ReportData,
} from "./types";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function changeClass(pct: number): string {
  if (pct > 0) return "up";
  if (pct < 0) return "down";
  return "flat";
}

const CHANGE_COLOR: Record<string, string> = { up: PALETTE.green, down: PALETTE.red, flat: PALETTE.muted };

const DATE_BADGE_STYLE: Record<string, { bg: string; fg: string }> = {
  today: { bg: PALETTE.redSoft, fg: "#991b1b" },
  tomorrow: { bg: PALETTE.amberSoft, fg: "#92400e" },
  soon: { bg: PALETTE.amberSoft, fg: "#92400e" },
  later: { bg: PALETTE.blueSoft, fg: PALETTE.navyAccent },
};

const SENTIMENT_STYLE: Record<string, { bg: string; fg: string }> = {
  "extreme-fear": { bg: PALETTE.redSoft, fg: "#991b1b" },
  fear: { bg: PALETTE.amberSoft, fg: "#92400e" },
  neutral: { bg: "#e2e8f0", fg: PALETTE.muted },
  greed: { bg: PALETTE.greenSoft, fg: "#065f46" },
  "extreme-greed": { bg: PALETTE.greenSoft, fg: "#064e3b" },
};

function fmtFollowUpMove(pct: number | null): string {
  if (pct === null) return "Unavailable";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

// Section heading – bold navy label, consistent 20px top margin between
// sections (email clients respect inline margin on table cells reliably).
function h(title: string): string {
  return `<div style="font-size:16px;font-weight:700;color:${PALETTE.navy};margin:0 0 10px;">${esc(title)}</div>`;
}

function sectionWrap(inner: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td>${inner}</td></tr></table>`;
}

function card(inner: string, extraStyle = "", className = ""): string {
  const classAttr = className ? ` class="${className}"` : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"${classAttr} style="background:${PALETTE.cardBg};border:1px solid ${PALETTE.border};border-radius:12px;${extraStyle}"><tr><td style="padding:14px 16px;">${inner}</td></tr></table>`;
}

function emptyNotice(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.cardBg};border:1px dashed ${PALETTE.border};border-radius:8px;"><tr><td style="padding:12px 14px;color:${PALETTE.muted};font-size:13px;">${esc(text)}</td></tr></table>`;
}

// ===== 0. Header =====

function htmlHeader(data: ReportData, today: string): string {
  const fg = data.fearGreed;
  const sentiment = fg ? SENTIMENT_STYLE[sentimentTone(fg.score)] : SENTIMENT_STYLE.neutral;
  const sentimentText = fg ? `Sentiment: ${esc(fg.classification)} (${fg.score})` : "Sentiment: Unavailable";
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.navy};">
    <tr>
      <td style="padding:24px 24px 20px;">
        <div style="font-size:22px;font-weight:800;color:#ffffff;">Daily Market Report</div>
        <div style="font-size:13px;color:rgba(255,255,255,.75);margin:4px 0 14px;">${ltr(esc(today))}</div>
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="padding-inline-end:10px;">
            <span style="display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:700;background:${sentiment.bg};color:${sentiment.fg};">${esc(sentimentText)}</span>
          </td>
          <td>
            <span style="font-size:12.5px;color:rgba(255,255,255,.85);">${ltr(esc(dataFreshnessLine(data.status)))}</span>
          </td>
        </tr></table>
      </td>
    </tr>
  </table>`;
}

// ===== 1. Upcoming Earnings Calendar =====

function htmlEarningsCalendar(entries: EarningsCalendarEntry[], status: ReportData["earningsCalendarStatus"]): string {
  if (entries.length === 0) {
    return sectionWrap(`${h("Upcoming Earnings Calendar")}${emptyNotice(earningsCalendarStatusMessageHebrew(status))}`);
  }
  const rows = entries
    .slice(0, 12)
    .map((e) => {
      const tone = DATE_BADGE_STYLE[earningsDateBadgeTone(e.daysRemaining)];
      return `
        <tr class="earnings-row">
          <td style="padding:9px 10px;border-bottom:1px solid ${PALETTE.border};font-size:13px;">
            <strong style="color:${PALETTE.navy};">${ltr(esc(e.ticker))}</strong><br>
            <span style="font-size:11.5px;color:${PALETTE.muted};">${esc(e.name)}</span>
          </td>
          <td style="padding:9px 10px;border-bottom:1px solid ${PALETTE.border};font-size:13px;">${ltr(esc(e.reportDate))}</td>
          <td style="padding:9px 10px;border-bottom:1px solid ${PALETTE.border};font-size:12.5px;color:${PALETTE.muted};">${e.timeOfDay === "pre-market" ? "Pre-Market" : e.timeOfDay === "post-market" ? "After Market" : "Unavailable"}</td>
          <td style="padding:9px 10px;border-bottom:1px solid ${PALETTE.border};">
            <span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:11.5px;font-weight:700;background:${tone.bg};color:${tone.fg};">${esc(daysRemainingLabelHebrew(e.daysRemaining))}</span>
          </td>
        </tr>`;
    })
    .join("");

  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    <tr>
      <th style="text-align:start;padding:8px 10px;font-size:10.5px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Company</th>
      <th style="text-align:start;padding:8px 10px;font-size:10.5px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Date</th>
      <th style="text-align:start;padding:8px 10px;font-size:10.5px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Time</th>
      <th style="text-align:start;padding:8px 10px;font-size:10.5px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Days Remaining</th>
    </tr>
    ${rows}
  </table>`;

  return sectionWrap(`${h("Upcoming Earnings Calendar")}${card(table)}`);
}

// ===== 2. Next Major Market Catalyst =====

function htmlMarketCatalyst(catalyst: MarketCatalystResult): string {
  if (!catalyst.catalyst) {
    return sectionWrap(`${h("Next Major Market Catalyst")}${emptyNotice(marketCatalystStatusMessageHebrew(catalyst.status))}`);
  }
  const c = catalyst.catalyst;
  const inner = `
    <div style="font-size:11px;font-weight:700;color:#991b1b;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;">${esc(c.timingHebrew)} · ${ltr(esc(c.reportDate))}</div>
    <div style="font-size:18px;font-weight:800;color:${PALETTE.navy};margin-bottom:6px;">${esc(c.headline)}</div>
    <div style="font-size:12.5px;color:${PALETTE.muted};margin-bottom:8px;">${ltr(esc(c.ticker))}</div>
    <div style="font-size:13.5px;color:${PALETTE.navy};">${esc(catalystWhyItMattersHebrew(c.ticker))}</div>`;
  return sectionWrap(`${h("Next Major Market Catalyst")}${card(inner, `border-right:4px solid ${PALETTE.red};background:${PALETTE.redSoft};`)}`);
}

// ===== 3. Market Story of the Day =====

function htmlMarketStory(story: MarketStory | null): string {
  if (!story) {
    return sectionWrap(`${h("Market Story of the Day")}${emptyNotice("לא נמצאה ידיעה חדשותית מהותית היום.")}`);
  }
  const move =
    story.priceMove && story.priceMove.price > 0
      ? ` · <span style="color:${CHANGE_COLOR[changeClass(story.priceMove.changePercent)]};font-weight:700;">${ltr(esc(fmtChange(story.priceMove.changePercent)))}</span>`
      : "";
  const inner = `
    <div style="margin-bottom:6px;">
      <span style="background:${PALETTE.navy};color:#fff;font-weight:800;font-size:11.5px;padding:2px 8px;border-radius:6px;">${ltr(esc(story.ticker))}</span>
      <span style="color:${PALETTE.muted};font-size:12.5px;font-weight:600;">${esc(story.companyName)}</span>${move}
    </div>
    <div style="font-size:16px;font-weight:700;color:${PALETTE.navy};margin-bottom:6px;">${ltr(esc(story.headline))}</div>
    <div style="font-size:12px;color:${PALETTE.muted};margin-bottom:10px;">${esc(story.source)} · ${ltr(esc(story.publishedDisplay))}</div>
    ${story.isFallback ? `<div style="font-size:11.5px;color:${PALETTE.amber};font-weight:700;margin-bottom:8px;">⚠️ ${esc(FALLBACK_NOTICE)}</div>` : ""}
    <div style="margin-bottom:8px;"><strong style="font-size:12.5px;color:${PALETTE.navy};">מה קרה</strong><br><span style="font-size:13.5px;">${esc(story.summaryHebrew)}</span></div>
    <div style="margin-bottom:10px;"><strong style="font-size:12.5px;color:${PALETTE.navy};">למה זה חשוב</strong><br><span style="font-size:13.5px;">${esc(story.whyMattersHebrew)}</span></div>
    <a href="${esc(story.url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:${PALETTE.navyAccent};color:#ffffff;font-weight:700;font-size:12.5px;text-decoration:none;padding:8px 16px;border-radius:999px;">Read full article</a>`;
  return sectionWrap(`${h("Market Story of the Day")}${card(inner)}`);
}

// ===== 4. Important Headlines =====

function htmlImportantHeadlines(items: MarketStory[]): string {
  if (items.length === 0) {
    return sectionWrap(`${h("Important Headlines")}${emptyNotice("אין כותרות נוספות מהותיות היום.")}`);
  }
  const cards = items
    .map(
      (a) => `<tr><td style="padding-bottom:10px;">${card(
        `<span style="background:${PALETTE.navy};color:#fff;font-weight:800;font-size:11px;padding:2px 7px;border-radius:6px;">${ltr(esc(a.ticker))}</span> <span style="color:${PALETTE.muted};font-size:12px;font-weight:600;">${esc(a.companyName)}</span><br><span style="font-size:13px;color:${PALETTE.navy};">${ltr(esc(a.headline))}</span><br><span style="font-size:11.5px;color:${PALETTE.muted};">${esc(a.source)}</span>`
      )}</td></tr>`
    )
    .join("");
  return sectionWrap(`${h("Important Headlines")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}</table>`);
}

// ===== 5. Market Overview =====
//
// Email-safe two-column table layout: pairs of tiles per row, degrading to
// one column per row on narrow screens via the @media rule declared in the
// document head (Gmail/most modern clients honor it; clients that don't
// simply keep the functional two-column table).

function overviewTileHtml(i: MarketOverviewItem): string {
  const value = formatOverviewValue(i);
  const change =
    i.changePercent !== null
      ? `<br><span style="font-size:12px;font-weight:700;color:${CHANGE_COLOR[changeClass(i.changePercent)]};">${ltr(esc(fmtChange(i.changePercent)))}</span>`
      : "";
  return `<td class="overview-tile-cell" data-metric-key="${esc(i.key)}" width="50%" valign="top" style="padding:6px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.cardBg};border:1px solid ${PALETTE.border};border-radius:8px;">
      <tr><td style="padding:10px 12px;">
        <div class="overview-tile" data-metric-key="${esc(i.key)}" style="font-size:11px;color:${PALETTE.muted};font-weight:600;text-transform:uppercase;">${esc(i.label)}</div>
        <div style="font-size:16px;font-weight:800;color:${PALETTE.navy};">${ltrTagged(esc(value), `data-metric-value-key="${esc(i.key)}"`)}</div>${change}
      </td></tr>
    </table>
  </td>`;
}

function htmlMarketOverview(items: MarketOverviewItem[]): string {
  const visible = visibleOverviewItems(items);
  if (visible.length < MIN_VISIBLE_INDICATORS) {
    return sectionWrap(`${h("Market Overview")}${emptyNotice("נתוני שוק כלליים אינם זמינים מספיק כרגע.")}`);
  }
  const rowsHtml: string[] = [];
  for (let i = 0; i < visible.length; i += 2) {
    const pair = visible.slice(i, i + 2);
    const cells = pair.map(overviewTileHtml).join("");
    const filler = pair.length === 1 ? `<td width="50%" style="padding:6px;">&nbsp;</td>` : "";
    rowsHtml.push(`<tr>${cells}${filler}</tr>`);
  }
  return sectionWrap(`${h("Market Overview")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="overview-table">${rowsHtml.join("")}</table>`);
}

// ===== 6. Technical Watch =====

function htmlTechnicalWatch(items: ReportData["technicalWatch"], dataUnavailable: boolean): string {
  if (dataUnavailable || items.length === 0) {
    return sectionWrap(`${h("Technical Watch")}${emptyNotice("נתונים טכניים אינם זמינים כרגע.")}`);
  }
  const rows = items
    .map((i) => {
      const hasPrice = i.price > 0;
      const rsi = i.rsi14 !== null ? `${Math.round(i.rsi14)} (${esc(rsiInterpretation(i.rsi14).label)})` : "—";
      const priceCell = hasPrice
        ? `${ltr(esc(fmtPrice(i.price)))}${i.isLastClose ? ` <span style="color:${PALETTE.mutedSoft};font-size:11px;">(Last close)</span>` : ""}`
        : `<span style="color:${PALETTE.mutedSoft};font-style:italic;">Price unavailable</span>`;
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid ${PALETTE.border};font-size:13px;"><strong style="color:${PALETTE.navy};">${ltr(esc(i.ticker))}</strong></td>
        <td style="padding:8px 10px;border-bottom:1px solid ${PALETTE.border};font-size:13px;">${priceCell}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${PALETTE.border};font-size:12.5px;">${esc(rsi)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${PALETTE.border};font-size:12.5px;">${esc(i.statusHebrew)}</td>
      </tr>`;
    })
    .join("");
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <th style="text-align:start;padding:8px 10px;font-size:10.5px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Ticker</th>
      <th style="text-align:start;padding:8px 10px;font-size:10.5px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Price</th>
      <th style="text-align:start;padding:8px 10px;font-size:10.5px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">RSI</th>
      <th style="text-align:start;padding:8px 10px;font-size:10.5px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Signal</th>
    </tr>
    ${rows}
  </table>`;
  return sectionWrap(`${h("Technical Watch")}${card(table)}`);
}

// ===== 7. Earnings Follow-up =====

function htmlEarningsFollowUp(followUp: EarningsFollowUpResult): string {
  if (followUp.entries.length === 0) {
    return sectionWrap(`${h("Earnings Follow-up")}${emptyNotice(earningsFollowUpStatusMessageHebrew(followUp.status))}`);
  }
  const rows = followUp.entries
    .slice(0, 12)
    .map((e) => {
      const color = e.priceChangeSincePct === null ? PALETTE.muted : CHANGE_COLOR[changeClass(e.priceChangeSincePct)];
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid ${PALETTE.border};font-size:13px;"><strong style="color:${PALETTE.navy};">${ltr(esc(e.ticker))}</strong><br><span style="font-size:11.5px;color:${PALETTE.muted};">${esc(e.name)}</span></td>
        <td style="padding:8px 10px;border-bottom:1px solid ${PALETTE.border};font-size:12.5px;">${ltr(esc(e.reportDate))}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${PALETTE.border};font-size:13px;font-weight:700;color:${color};">${ltr(esc(fmtFollowUpMove(e.priceChangeSincePct)))}</td>
      </tr>`;
    })
    .join("");
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <th style="text-align:start;padding:8px 10px;font-size:10.5px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Company</th>
      <th style="text-align:start;padding:8px 10px;font-size:10.5px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Earnings Date</th>
      <th style="text-align:start;padding:8px 10px;font-size:10.5px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Price Reaction</th>
    </tr>
    ${rows}
  </table>`;
  return sectionWrap(`${h("Earnings Follow-up")}${card(table)}`);
}

// ===== 8. Top Opportunities =====

function metricChipHtml(label: string, value: string): string {
  return `<td style="padding:4px;"><table role="presentation" cellpadding="0" cellspacing="0" style="background:${PALETTE.pageBg};border-radius:6px;"><tr><td style="padding:5px 10px;"><div style="font-size:10px;color:${PALETTE.muted};text-transform:uppercase;">${esc(label)}</div><div style="font-size:13px;font-weight:700;color:${PALETTE.navy};">${esc(value)}</div></td></tr></table></td>`;
}

function opportunityCardHtml(rank: number, s: EnrichedStock, thesis: OpportunityThesis | undefined): string {
  const dq = s.dataQuality;
  const changeHtml =
    s.price > 0
      ? `<span style="font-size:12.5px;font-weight:700;color:${CHANGE_COLOR[changeClass(s.changePercent)]};">${ltr(esc(fmtChange(s.changePercent)))}</span>`
      : "";
  const field = (label: string, value: string, primary: boolean) =>
    `<div style="margin-top:8px;${primary ? "" : "opacity:.78;"}"><strong style="font-size:${primary ? "12.5px" : "11.5px"};color:${primary ? PALETTE.navy : PALETTE.muted};">${esc(label)}</strong><br><span style="font-size:${primary ? "13px" : "12px"};color:${PALETTE.navy};">${esc(value)}</span></div>`;

  const inner = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="top">
        <span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:999px;background:${PALETTE.pageBg};color:${PALETTE.muted};font-weight:800;font-size:11px;">#${rank}</span>
        <strong style="font-size:17px;color:${PALETTE.navy};margin-inline-start:8px;">${ltr(esc(s.ticker))}</strong>
        <div style="font-size:12.5px;color:${PALETTE.muted};margin-top:2px;">${esc(displayName(s))}</div>
      </td>
      <td valign="top" align="right" style="white-space:nowrap;">
        <span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${PALETTE.blueSoft};color:${PALETTE.navyAccent};font-weight:800;font-size:14px;">${s.finalScore.toFixed(1)}/10</span><br>
        ${changeHtml}
      </td>
    </tr></table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:10px;"><tr>
      ${metricChipHtml("Coverage", dq ? `${dq.coverageScore}` : "—")}
      ${metricChipHtml("Confidence", dq ? `${dq.confidenceScore}` : "—")}
      ${metricChipHtml("Risk Level", riskLevelHebrew(s.tier))}
    </tr></table>
    ${field("למה עכשיו", thesis?.whyToday ?? s.whyHebrew, true)}
    ${field("קטליזטור קרוב", thesis?.catalyst ?? "—", true)}
    ${field("סיכון מרכזי", thesis?.mainRisk ?? "—", true)}
    ${field("מה השתנה לאחרונה", thesis?.whatChanged ?? "—", false)}
    ${field("מדדים מרכזיים", thesis?.keyMetric ?? "—", false)}
    ${field("מה יפריך את התזה", thesis?.invalidation ?? "—", false)}`;

  return `<tr><td style="padding-bottom:14px;">${card(inner, `border-right:4px solid ${PALETTE.blue};`, "opportunity-card")}</td></tr>`;
}

// Top Opportunities NEVER contains an Emergency-Mode-promoted stock – when
// nothing clears the normal bar this simply shows fewer than 3 (down to 0)
// rather than backfilling. See htmlEmergencyWatch below for where those go.
function htmlTopOpportunities(stocks: EnrichedStock[], theses: Map<string, OpportunityThesis>): string {
  if (stocks.length === 0) {
    return sectionWrap(`${h("Top Opportunities")}${emptyNotice("אין הזדמנויות שעברו את סף איכות הנתונים בריצה הזו.")}`);
  }
  const rows = stocks.map((s, idx) => opportunityCardHtml(idx + 1, s, theses.get(s.ticker))).join("");
  return sectionWrap(`${h("Top Opportunities")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`);
}

// ===== 8b. Reduced-Confidence Watch (Emergency Report Mode only) =====
//
// Renders nothing at all when Emergency Mode isn't engaged. A lighter card
// than a normal opportunity – no structured thesis, just the real numbers
// plus an explicit reliability caveat and badge – so it can never be
// mistaken for a normal high-confidence pick.
function emergencyWatchCardHtml(s: EnrichedStock): string {
  const dq = s.dataQuality;
  const changeHtml =
    s.price > 0
      ? `<span style="font-size:12.5px;font-weight:700;color:${CHANGE_COLOR[changeClass(s.changePercent)]};">${ltr(esc(fmtChange(s.changePercent)))}</span>`
      : "";
  const inner = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="top">
        <strong style="font-size:17px;color:${PALETTE.navy};">${ltr(esc(s.ticker))}</strong>
        <div style="font-size:12.5px;color:${PALETTE.muted};margin-top:2px;">${esc(displayName(s))}</div>
      </td>
      <td valign="top" align="right" style="white-space:nowrap;">
        <span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${PALETTE.pageBg};color:${PALETTE.muted};font-weight:800;font-size:14px;">${s.finalScore.toFixed(1)}/10</span><br>
        ${changeHtml}
      </td>
    </tr></table>
    <div style="margin-top:8px;padding:4px 10px;border-radius:6px;background:#fef3c7;color:#92400e;font-weight:800;font-size:11.5px;display:inline-block;">⚠️ ${EMERGENCY_MODE_LABEL}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:10px;"><tr>
      ${metricChipHtml("Coverage", dq ? `${dq.coverageScore}` : "—")}
      ${metricChipHtml("Confidence", dq ? `${dq.confidenceScore}` : "—")}
    </tr></table>
    <p style="margin-top:10px;font-size:12px;color:${PALETTE.muted};">${esc(dq?.reliabilityHebrew ?? "")}</p>`;

  return `<tr><td style="padding-bottom:14px;">${card(inner, `border-right:4px solid ${PALETTE.amber};`, "opportunity-card")}</td></tr>`;
}

function htmlEmergencyWatch(stocks: EnrichedStock[]): string {
  if (stocks.length === 0) return "";
  const notice = emptyNotice(EMERGENCY_MODE_EXPLANATION_HEBREW);
  const rows = stocks.map((s) => emergencyWatchCardHtml(s)).join("");
  return sectionWrap(`${h("⚠️ Reduced-Confidence Watch")}${notice}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`);
}

// ===== 9. Dividend Information (secondary, visually smaller) =====

function htmlDividends(items: DividendInfoItem[], status: DividendsStatus): string {
  const smallHeading = `<div style="font-size:13px;font-weight:700;color:${PALETTE.muted};text-transform:uppercase;letter-spacing:.02em;margin:0 0 8px;">Dividend Information</div>`;
  if (items.length === 0) {
    const msg =
      status === "unavailable"
        ? "לא ניתן היה לאמת נתוני דיבידנד בריצה הזו – פרופיל החברה לא היה זמין מאף ספק."
        : "אף אחת מהמניות המדווחות אינה מחלקת דיבידנד כרגע.";
    return sectionWrap(`${smallHeading}${emptyNotice(msg)}`);
  }
  const rows = items
    .map(
      (d) => `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid ${PALETTE.border};font-size:12.5px;"><strong style="color:${PALETTE.navy};">${ltr(esc(d.ticker))}</strong></td>
        <td style="padding:6px 10px;border-bottom:1px solid ${PALETTE.border};font-size:12.5px;">${ltr(esc(`$${d.dividendPerShare.toFixed(2)}`))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid ${PALETTE.border};font-size:12.5px;">${d.dividendYieldPct !== null ? ltr(esc(`${d.dividendYieldPct.toFixed(2)}%`)) : "Unavailable"}</td>
      </tr>`
    )
    .join("");
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <th style="text-align:start;padding:6px 10px;font-size:10px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Ticker</th>
      <th style="text-align:start;padding:6px 10px;font-size:10px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Annual Dividend</th>
      <th style="text-align:start;padding:6px 10px;font-size:10px;color:${PALETTE.muted};text-transform:uppercase;background:${PALETTE.pageBg};">Yield</th>
    </tr>
    ${rows}
  </table>`;
  return sectionWrap(`${smallHeading}${card(table, "opacity:.95;")}`);
}

// ===== 10. This Week To Watch – FUTURE events only (upcoming earnings not
// already shown in the Upcoming Earnings Calendar). Hidden entirely when
// there's nothing forward-looking. Already-published macro readings get
// their own, honestly-labeled section below (htmlRecentMacro) – never
// presented under a "To Watch" heading. =====

function htmlWeekAhead(data: ReportData): string {
  const extraEarnings = weekAheadExtraEarnings(data);
  if (extraEarnings.length === 0) return "";

  const smallHeading = `<div style="font-size:13px;font-weight:700;color:${PALETTE.muted};text-transform:uppercase;letter-spacing:.02em;margin:0 0 8px;">This Week To Watch</div>`;
  const earningsHtml = `<div class="week-ahead-earnings"><strong style="font-size:12px;">דיווחי רווחים קרובים</strong><br>${extraEarnings.map((e) => `${ltr(esc(e.ticker))} — ${ltr(esc(e.reportDate))}`).join("<br>")}</div>`;

  return sectionWrap(`${smallHeading}${card(earningsHtml, "opacity:.95;")}`);
}

// ===== 10b. Recent Macro Data – explicitly labeled as ALREADY PUBLISHED. =====

function htmlRecentMacro(data: ReportData): string {
  const smallHeading = `<div style="font-size:13px;font-weight:700;color:${PALETTE.muted};text-transform:uppercase;letter-spacing:.02em;margin:0 0 8px;">Recent Macro Data (Already Published)</div>`;
  const week = data.weekAhead;
  const econHtml =
    week.economicReadings.length > 0
      ? `<div>${week.economicReadings
          .map((r) => `${esc(r.label)}: ${ltr(esc(String(r.value) + r.unit))}`)
          .join("<br>")}</div>`
      : `<div style="font-size:12.5px;color:${PALETTE.muted};">נתוני מאקרו אחרונים אינם זמינים כרגע.</div>`;

  return sectionWrap(`${smallHeading}${card(econHtml, "opacity:.95;")}`);
}

// ===== 11. Data Diagnostics (bottom, muted) =====

function htmlDiagnostics(data: ReportData): string {
  const { status, scanned, qualified } = data;
  const inner = `<span style="font-weight:700;color:${PALETTE.navy};">Data quality</span><br>
    <span style="font-size:12.5px;color:${PALETTE.muted};">${status.liveCount} Live · ${status.cachedCount} Cached · ${status.missingCount} Unavailable</span><br>
    <span style="font-size:12px;color:${PALETTE.mutedSoft};">${scanned} scanned · ${qualified} qualified</span>`;
  const rateLimitNotice = status.rateLimitHit
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:${PALETTE.amberSoft};color:#92400e;border-radius:8px;padding:8px 12px;font-size:12px;">⚠️ Alpha Vantage rate limit hit during this run.</td></tr></table>`
    : "";
  return sectionWrap(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="diagnostics-card" style="background:${PALETTE.pageBg};border:1px solid ${PALETTE.border};border-radius:8px;"><tr><td style="padding:10px 14px;">${inner}</td></tr></table>${rateLimitNotice}`);
}

function htmlFooter(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${PALETTE.border};margin-top:8px;">
    <tr><td style="padding-top:14px;font-size:11.5px;color:${PALETTE.mutedSoft};">
      <strong style="color:${PALETTE.muted};">Research only. Not investment advice.</strong> מסחר במניות כרוך בסיכון לאובדן ההון.<br>
      קבצים מצורפים: daily-stock-report.html · daily-stock-report.md
    </td></tr>
  </table>`;
}

// Minimal @media rule for progressive mobile stacking of the Market
// Overview two-column table – degrades gracefully to a functional 2-column
// table in clients that ignore it (no JS, no flexbox/grid anywhere).
const EMAIL_MEDIA_STYLE = `
  @media (max-width: 480px) {
    .overview-tile-cell { display:block !important; width:100% !important; }
  }
`;

// ===== Diagnostic-only email body (Report Quality Score below SEND_THRESHOLD) =====
//
// Rendered INSTEAD of the normal email body – see src/reportQuality.ts and
// pipeline.ts. Reuses the same header/palette/680px shell as the normal
// email (same visual system), just with a short, honest body.

function diagnosticProviderIssuesHtml(data: ReportData): string {
  const failing = data.reportQuality.dimensions.filter((d) => d.scorePct < 60);
  const rows =
    failing.length > 0
      ? failing.map((d) => `<div style="margin-top:4px;font-size:12.5px;">• <strong>${esc(d.label)}</strong>: ${d.scorePct}% (${esc(d.detail)})</div>`).join("")
      : `<div style="font-size:12.5px;">לא זוהה כשל ספק בודד וחמור – הציון ירד משילוב של כמה פערי כיסוי חלקיים.</div>`;
  return sectionWrap(`${h("Provider Issues")}${card(rows)}`);
}

function diagnosticLastVerifiedHtml(data: ReportData): string {
  const rows = data.watchlist
    .map((s) => {
      const src = s.quoteSource;
      const label =
        !src || src.source === "unavailable"
          ? "לא זמין"
          : src.source === "live"
          ? "עדכני (נשלף כעת)"
          : `במטמון (${src.ageHours ?? "?"} שעות)`;
      return `<div style="margin-top:4px;font-size:12.5px;">• <strong>${ltr(esc(s.ticker))}</strong>: ${esc(label)}</div>`;
    })
    .join("");
  return sectionWrap(`${h("Last Verified Data")}${card(rows)}`);
}

function generateDiagnosticEmailHtmlBody(data: ReportData, today: string): string {
  const q = data.reportQuality;
  const notice = sectionWrap(
    card(
      `<div style="font-weight:800;color:${PALETTE.amber};margin-bottom:6px;">⚠️ הדוח היום לא הופק ברמת האיכות הרגילה</div>` +
        `<div style="font-size:13px;color:${PALETTE.navy};">Today's market report could not be produced at normal quality (Report Quality Score: ${q.score}/100 – ${esc(q.band)}). This is a short diagnostic summary instead of the full newsletter.</div>`,
      `border-right:4px solid ${PALETTE.amber};`
    )
  );

  const sections = [
    notice,
    htmlMarketOverview(data.marketOverview),
    htmlEarningsCalendar(data.earningsCalendar, data.earningsCalendarStatus),
    diagnosticProviderIssuesHtml(data),
    diagnosticLastVerifiedHtml(data),
    htmlDiagnostics(data),
    htmlFooter(),
  ].join("\n");

  return `<style>${EMAIL_MEDIA_STYLE}</style>
  <div dir="rtl" lang="he" style="font-family:Arial,Helvetica,sans-serif;background:${PALETTE.pageBg};padding:16px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${EMAIL_MAX_WIDTH}px;margin:0 auto;background:${PALETTE.pageBg};">
      <tr><td>
        ${htmlHeader(data, today)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:20px;">
          <tr><td>${sections}</td></tr>
        </table>
      </td></tr>
    </table>
  </div>
  ${fingerprintHtmlComment(data)}
  ${provenanceHtmlComment(data)}`;
}

export function generateEmailHtmlBody(data: ReportData, today: string): string {
  if (data.belowSendThreshold) return generateDiagnosticEmailHtmlBody(data, today);
  const sections = [
    htmlEarningsCalendar(data.earningsCalendar, data.earningsCalendarStatus),
    htmlMarketCatalyst(data.marketCatalyst),
    htmlMarketStory(data.marketStory),
    htmlImportantHeadlines(data.additionalHeadlines),
    htmlMarketOverview(data.marketOverview),
    htmlTechnicalWatch(data.technicalWatch, data.technicalAlerts.dataUnavailable),
    htmlEarningsFollowUp(data.earningsFollowUp),
    htmlTopOpportunities(data.topOpportunities, data.opportunityTheses),
    htmlEmergencyWatch(data.emergencyWatch),
    htmlDividends(data.dividends, data.dividendsStatus),
    htmlWeekAhead(data),
    htmlRecentMacro(data),
    htmlDiagnostics(data),
    htmlFooter(),
  ].join("\n");

  return `<style>${EMAIL_MEDIA_STYLE}</style>
  <div dir="rtl" lang="he" style="font-family:Arial,Helvetica,sans-serif;background:${PALETTE.pageBg};padding:16px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${EMAIL_MAX_WIDTH}px;margin:0 auto;background:${PALETTE.pageBg};">
      <tr><td>
        ${htmlHeader(data, today)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:20px;">
          <tr><td>${sections}</td></tr>
        </table>
      </td></tr>
    </table>
  </div>
  ${fingerprintHtmlComment(data)}
  ${provenanceHtmlComment(data)}`;
}

// ===== Plain-text body =====
//
// Kept simple/text-based, same as the Markdown report – only the shared
// Market Overview currency-formatting fix is applied here too.

function textEarningsCalendar(entries: EarningsCalendarEntry[], status: ReportData["earningsCalendarStatus"]): string {
  if (entries.length === 0) {
    return `📅 Upcoming Earnings Calendar:\n  ${earningsCalendarStatusMessageHebrew(status)}`;
  }
  const lines = entries
    .slice(0, 12)
    .map((e) => `  • ${e.ticker} – ${e.name} · ${e.reportDate}`)
    .join("\n");
  return `📅 Upcoming Earnings Calendar:\n${lines}`;
}

function textMarketCatalyst(catalyst: MarketCatalystResult): string {
  if (!catalyst.catalyst) {
    return `🚨 Next Major Market Catalyst:\n  ${marketCatalystStatusMessageHebrew(catalyst.status)}`;
  }
  const c = catalyst.catalyst;
  return `🚨 Next Major Market Catalyst:\n  ${c.headline} (${c.ticker} · ${c.reportDate} · ${c.timingHebrew})`;
}

function textMarketStory(story: MarketStory | null): string {
  if (!story) return `📰 Market Story of the Day:\n  לא נמצאה ידיעה חדשותית מהותית היום.`;
  const fallbackLine = story.isFallback ? `\n  ⚠️ ${FALLBACK_NOTICE}` : "";
  return `📰 Market Story of the Day:
  ${story.ticker} – ${story.companyName}
  "${story.headline}"
  🗞️ ${story.source} · 🕒 ${story.publishedDisplay}${fallbackLine}
  ${story.summaryHebrew}
  למה זה חשוב למשקיע לטווח ארוך: ${story.whyMattersHebrew}
  🔗 ${story.url}`;
}

function textImportantHeadlines(items: MarketStory[]): string {
  if (items.length === 0) return `🗞️ Important Headlines:\n  אין כותרות נוספות מהותיות היום.`;
  const lines = items.map((a) => `  • ${a.ticker} (${a.companyName}) — "${a.headline}" (${a.source})`).join("\n");
  return `🗞️ Important Headlines:\n${lines}`;
}

function textMarketOverview(items: MarketOverviewItem[]): string {
  const visible = visibleOverviewItems(items);
  if (visible.length < MIN_VISIBLE_INDICATORS) {
    return `🌎 Market Overview:\n  נתוני שוק כלליים אינם זמינים מספיק כרגע.`;
  }
  const lines = visible.map((i) => `  • ${i.label}: ${formatOverviewValue(i)}`).join("\n");
  return `🌎 Market Overview:\n${lines}`;
}

function textTechnicalWatch(items: ReportData["technicalWatch"], dataUnavailable: boolean): string {
  if (dataUnavailable || items.length === 0) return `📊 Technical Watch:\n  נתונים טכניים אינם זמינים כרגע.`;
  const lines = items
    .map((i) => {
      const priceLabel = i.price > 0 ? `${fmtPrice(i.price)}${i.isLastClose ? " (Last close)" : ""}` : "Price unavailable";
      return `  • ${i.ticker} – ${priceLabel} · ${i.statusHebrew}`;
    })
    .join("\n");
  return `📊 Technical Watch:\n${lines}`;
}

function textEarningsFollowUp(followUp: EarningsFollowUpResult): string {
  if (followUp.entries.length === 0) {
    return `📮 Earnings Follow-up:\n  ${earningsFollowUpStatusMessageHebrew(followUp.status)}`;
  }
  const lines = followUp.entries
    .slice(0, 12)
    .map((e) => `  • ${e.ticker} – ${e.name} · ${e.reportDate} · ${fmtFollowUpMove(e.priceChangeSincePct)}`)
    .join("\n");
  return `📮 Earnings Follow-up:\n${lines}`;
}

// Top Opportunities NEVER contains an Emergency-Mode-promoted stock – see
// textEmergencyWatch below for where those go instead.
function textTopOpportunities(stocks: EnrichedStock[]): string {
  if (stocks.length === 0) return `🎯 Top Opportunities (0/3):\n  —`;
  const lines = stocks
    .map((s) => `  • ${s.ticker} – ${displayName(s)} (ציון ${s.finalScore.toFixed(1)}/10${s.price > 0 ? `, ${fmtChange(s.changePercent)}` : ""})`)
    .join("\n");
  return `🎯 Top Opportunities (${stocks.length}/3):\n${lines}`;
}

// Renders nothing at all when Emergency Mode isn't engaged.
function textEmergencyWatch(stocks: EnrichedStock[]): string {
  if (stocks.length === 0) return "";
  const lines = stocks
    .map(
      (s) =>
        `  • ${s.ticker} – ${displayName(s)} (ציון ${s.finalScore.toFixed(1)}/10) [⚠️ ${EMERGENCY_MODE_LABEL}]`
    )
    .join("\n");
  return `⚠️ Reduced-Confidence Watch (${stocks.length}):\n  ${EMERGENCY_MODE_EXPLANATION_HEBREW}\n${lines}`;
}

function textDividends(items: DividendInfoItem[], status: DividendsStatus): string {
  if (items.length === 0) {
    return status === "unavailable"
      ? `💵 Dividend Information:\n  לא ניתן היה לאמת נתוני דיבידנד בריצה הזו (פרופיל חברה לא זמין).`
      : `💵 Dividend Information:\n  אף מניה כרגע אינה מחלקת דיבידנד.`;
  }
  const lines = items
    .map((d) => `  • ${d.ticker} – $${d.dividendPerShare.toFixed(2)}/share${d.dividendYieldPct !== null ? ` (${d.dividendYieldPct.toFixed(2)}% yield)` : ""}`)
    .join("\n");
  return `💵 Dividend Information:\n${lines}`;
}

// FUTURE events only – hidden entirely when there's nothing forward-looking
// beyond what the Upcoming Earnings Calendar already showed. See
// textRecentMacro below for already-published macro data, kept separate.
function textWeekAhead(data: ReportData): string {
  const extraEarnings = weekAheadExtraEarnings(data);
  if (extraEarnings.length === 0) return "";
  const lines = extraEarnings.map((e) => `  • ${e.ticker} — ${e.reportDate}`).join("\n");
  return `📅 This Week To Watch:\n${lines}`;
}

function textRecentMacro(week: ReportData["weekAhead"]): string {
  if (week.economicReadings.length === 0) {
    return `📅 Recent Macro Data (Already Published):\n  נתוני מאקרו אחרונים אינם זמינים כרגע.`;
  }
  const lines = week.economicReadings.map((r) => `  • ${r.label}: ${r.value}${r.unit}`).join("\n");
  return `📅 Recent Macro Data (Already Published):\n${lines}`;
}

function textDiagnostics(data: ReportData): string {
  const { status, scanned, qualified } = data;
  return `🧪 Data Diagnostics:
  🟢 Live: ${status.liveCount}  🟡 Cached: ${status.cachedCount}  🔴 Unavailable: ${status.missingCount}
  Scanned: ${scanned} · Qualified: ${qualified}${status.rateLimitHit ? "\n  ⚠️ הופעלה מגבלת ה-API בריצה זו." : ""}`;
}

function diagnosticProviderIssuesText(data: ReportData): string {
  const failing = data.reportQuality.dimensions.filter((d) => d.scorePct < 60);
  if (failing.length === 0) return `⚠️ Provider Issues:\n  לא זוהה כשל ספק בודד וחמור.`;
  const lines = failing.map((d) => `  • ${d.label}: ${d.scorePct}% (${d.detail})`).join("\n");
  return `⚠️ Provider Issues:\n${lines}`;
}

function diagnosticLastVerifiedText(data: ReportData): string {
  const lines = data.watchlist
    .map((s) => {
      const src = s.quoteSource;
      const label =
        !src || src.source === "unavailable"
          ? "לא זמין"
          : src.source === "live"
          ? "עדכני"
          : `במטמון (${src.ageHours ?? "?"} שעות)`;
      return `  • ${s.ticker}: ${label}`;
    })
    .join("\n");
  return `🕒 Last Verified Data:\n${lines}`;
}

function generateDiagnosticEmailTextBody(data: ReportData, today: string): string {
  const q = data.reportQuality;
  const sections = [
    `⚠️ הדוח היום לא הופק ברמת האיכות הרגילה (Report Quality Score: ${q.score}/100 – ${q.band})`,
    textMarketOverview(data.marketOverview),
    textEarningsCalendar(data.earningsCalendar, data.earningsCalendarStatus),
    diagnosticProviderIssuesText(data),
    diagnosticLastVerifiedText(data),
    textDiagnostics(data),
  ].join("\n\n");

  return `שלום,

הדוח היומי לתאריך ${today} לא הופק ברמת האיכות הרגילה – זהו סיכום דיאגנוסטי קצר במקום זאת.

${sections}

—
דוח אוטומטי שנוצר על ידי stock-agent. ${fingerprintTextTag(data)} ${provenanceTextTag(data)}
המידע הוא למטרות מחקר ולמידה בלבד – אינו ייעוץ השקעות.
`;
}

export function generateEmailTextBody(data: ReportData, today: string): string {
  if (data.belowSendThreshold) return generateDiagnosticEmailTextBody(data, today);
  const sections = [
    textEarningsCalendar(data.earningsCalendar, data.earningsCalendarStatus),
    textMarketCatalyst(data.marketCatalyst),
    textMarketStory(data.marketStory),
    textImportantHeadlines(data.additionalHeadlines),
    textMarketOverview(data.marketOverview),
    textTechnicalWatch(data.technicalWatch, data.technicalAlerts.dataUnavailable),
    textEarningsFollowUp(data.earningsFollowUp),
    textTopOpportunities(data.topOpportunities),
    textEmergencyWatch(data.emergencyWatch),
    textDividends(data.dividends, data.dividendsStatus),
    textWeekAhead(data),
    textRecentMacro(data.weekAhead),
    textDiagnostics(data),
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");

  return `שלום,

הדוח היומי לתאריך ${today} מצורף.

${sections}

הקבצים המצורפים:
  - daily-stock-report.html  (לפתיחה בדפדפן – מומלץ)
  - daily-stock-report.md    (גרסת טקסט)

—
דוח אוטומטי שנוצר על ידי stock-agent. ${fingerprintTextTag(data)} ${provenanceTextTag(data)}
המידע הוא למטרות מחקר ולמידה בלבד – אינו ייעוץ השקעות.
`;
}
