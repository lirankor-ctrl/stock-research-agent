import fs from "fs";
import path from "path";
import { earningsCalendarStatusMessageHebrew } from "./earningsCalendar";
import { FALLBACK_NOTICE } from "./marketStory";
import { earningsFollowUpStatusMessageHebrew } from "./earningsFollowUp";
import { EMERGENCY_MODE_LABEL, EMERGENCY_MODE_EXPLANATION_HEBREW } from "./emergencyMode";
import { marketCatalystStatusMessageHebrew } from "./marketCatalyst";
import { visibleOverviewItems, MIN_VISIBLE_INDICATORS } from "./marketOverview";
import { fingerprintHtmlComment, provenanceHtmlComment } from "./reportFingerprint";
import { formatOverviewValue, weekAheadExtraEarnings } from "./reportPresentation";
import { rsiInterpretation } from "./technicals";
import { watchlistName } from "./universe";
import {
  DataQualityLabel,
  DividendInfoItem,
  DividendsStatus,
  EarningsCalendarEntry,
  EarningsCalendarStatus,
  EarningsFollowUpResult,
  EarningsUrgency,
  EnrichedStock,
  MarketCatalystResult,
  MarketOverviewItem,
  MarketStory,
  OpportunityThesis,
  ReportData,
  TechnicalWatchItem,
  WeekAhead,
} from "./types";

function displayName(s: EnrichedStock): string {
  return s.profile?.name ?? watchlistName(s.ticker) ?? s.ticker;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtChange(pct: number): string {
  return pct >= 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`;
}

function fmtPrice(p: number): string {
  return p > 0 ? `$${p.toFixed(2)}` : "—";
}

function fmtDateTime(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const DQ_EMOJI: Record<DataQualityLabel, string> = {
  High: "🟢",
  Medium: "🟡",
  Low: "🟠",
  Excluded: "🔴",
};

function dqBadge(s: EnrichedStock): string {
  const dq = s.dataQuality;
  if (!dq) return "—";
  return `${DQ_EMOJI[dq.label]} ${dq.label} · כיסוי ${dq.coverageScore} · ביטחון ${dq.confidenceScore}`;
}

// ---------- 1. Upcoming Earnings ----------

const URGENCY_EMOJI: Record<EarningsUrgency, string> = {
  today: "🔴",
  tomorrow: "🟠",
  week: "🟡",
  later: "⚪",
};

function earningsCalendarSection(
  entries: EarningsCalendarEntry[],
  status: EarningsCalendarStatus
): string {
  if (entries.length === 0) {
    return `## 📅 Upcoming Earnings Calendar

_${earningsCalendarStatusMessageHebrew(status)}_`;
  }

  const header =
    "| | Symbol | Date | BMO/AMC | Days | EPS Est. | Revenue Est. | למה זה חשוב |\n" +
    "| - | ------ | ---- | ------- | ---- | -------- | ------------- | ------------ |";
  const rows = entries.slice(0, 12).map((e) => {
    const eps = e.estimatedEps !== undefined ? `$${e.estimatedEps.toFixed(2)}` : "Unavailable";
    const days = e.daysRemaining === 0 ? "היום" : e.daysRemaining === 1 ? "מחר" : `${e.daysRemaining}d`;
    const bmoAmc = e.timeOfDay === "pre-market" ? "🌅 BMO" : e.timeOfDay === "post-market" ? "🌇 AMC" : "Unavailable";
    return `| ${URGENCY_EMOJI[e.urgency]} | **${e.ticker}** | ${e.reportDate} | ${bmoAmc} | ${days} | ${eps} | Unavailable | ${e.reasonsHebrew.join(" · ")} |`;
  });

  return `## 📅 Upcoming Earnings Calendar

${[header, ...rows].join("\n")}`;
}

function marketCatalystSection(catalyst: MarketCatalystResult): string {
  if (!catalyst.catalyst) {
    return `## 🚨 Next Major Market Catalyst

_${marketCatalystStatusMessageHebrew(catalyst.status)}_`;
  }
  const c = catalyst.catalyst;
  return `## 🚨 Next Major Market Catalyst

> 🚨 **${c.headline}** (\`${c.ticker}\` · ${c.timingHebrew}, ${c.reportDate})`;
}

// ---------- 2. Market Story ----------

function marketStorySection(story: MarketStory | null): string {
  if (!story) {
    return `## 📰 Market Story of the Day

_לא נמצאה ידיעה חדשותית מהותית היום._`;
  }

  const moveLine =
    story.priceMove && story.priceMove.price > 0
      ? `\n- 📊 **תנועת מחיר:** ${fmtPrice(story.priceMove.price)} (${fmtChange(story.priceMove.changePercent)})`
      : "";
  const original = story.originalSummary
    ? `\n\n> _תקציר המקור (באנגלית):_ ${story.originalSummary}`
    : "";
  const fallbackLine = story.isFallback ? `\n\n⚠️ **${FALLBACK_NOTICE}**` : "";

  return `## 📰 Market Story of the Day

### \`${story.ticker}\` — ${story.companyName}

**${story.headline}**

- 🗞️ **מקור:** ${story.source}
- 🕒 **תאריך:** ${story.publishedDisplay}${moveLine}${fallbackLine}

${story.summaryHebrew}

**למה זה חשוב למשקיע לטווח ארוך:** ${story.whyMattersHebrew}

🔗 [קריאת הידיעה המלאה במקור](${story.url})${original}`;
}

function importantHeadlinesSection(additional: MarketStory[]): string {
  if (additional.length === 0) {
    return `## 🗞️ Important Headlines

_אין כותרות נוספות מהותיות היום מעבר לידיעה הראשית._`;
  }
  const lines = additional
    .map((a) => `- **${a.ticker}** (${a.companyName}) — "${a.headline}" (${a.source}, ${a.publishedDisplay}) [🔗](${a.url})`)
    .join("\n");
  return `## 🗞️ Important Headlines

${lines}`;
}

// ---------- 3. Market Overview ----------

function marketOverviewSection(items: MarketOverviewItem[]): string {
  const visible = visibleOverviewItems(items);

  if (visible.length < MIN_VISIBLE_INDICATORS) {
    return `## 🌎 Market Overview

_נתוני שוק כלליים אינם זמינים מספיק כרגע (${visible.length}/${items.length} מדדים בלבד) – הסעיף יתעדכן כשהמקור יחזור להיות זמין._`;
  }

  const header = "| Indicator | Value | Daily Change |\n| --------- | ----- | ------------ |";
  const rows = visible.map((i) => {
    const change = i.changePercent !== null ? fmtChange(i.changePercent) : "—";
    return `| ${i.label} | ${formatOverviewValue(i)} | ${change} |`;
  });
  return `## 🌎 Market Overview

${[header, ...rows].join("\n")}`;
}

// ---------- 4. Top Opportunities ----------

function opportunityBlock(s: EnrichedStock, thesis: OpportunityThesis | undefined): string {
  const name = displayName(s);
  return `### ${s.ticker} — ${name}

> ⭐ **${s.finalScore.toFixed(1)}/10** · 🧪 ${dqBadge(s)}

- 💰 ${fmtPrice(s.price)} (${s.price > 0 ? fmtChange(s.changePercent) : "—"})

**למה עכשיו:** ${thesis?.whyToday ?? s.whyHebrew}
**מה השתנה לאחרונה:** ${thesis?.whatChanged ?? "—"}
**מדדים מרכזיים:** ${thesis?.keyMetric ?? "—"}
**קטליזטור קרוב:** ${thesis?.catalyst ?? "—"}
**סיכון מרכזי:** ${thesis?.mainRisk ?? "—"}
**מה יפריך את התזה:** ${thesis?.invalidation ?? "—"}`;
}

// Top Opportunities NEVER contains an Emergency-Mode-promoted stock – when
// nothing clears the normal bar, this simply shows fewer than 3 (down to 0)
// rather than backfilling with reduced-confidence picks. See
// emergencyWatchSection below for where those go instead.
function topOpportunitiesSection(
  stocks: EnrichedStock[],
  theses: Map<string, OpportunityThesis>
): string {
  if (stocks.length === 0) {
    return `## 🎯 Top Opportunities

_אין הזדמנויות שעברו את סף איכות הנתונים בריצה הזו._`;
  }
  const body = stocks.map((s) => opportunityBlock(s, theses.get(s.ticker))).join("\n\n---\n\n");
  return `## 🎯 Top Opportunities (${stocks.length}/3)

${body}`;
}

// ---------- 4b. Reduced-Confidence Watch (Emergency Report Mode only) ----------
//
// Renders NOTHING (not even an empty-state heading) when Emergency Mode
// isn't engaged – this block only exists on the days it's actually needed,
// never as permanent clutter. A lighter format than Top Opportunities cards
// on purpose: no structured thesis, just the real numbers we do have plus an
// explicit reliability caveat, so it can never be mistaken for a normal pick.
function emergencyWatchSection(stocks: EnrichedStock[]): string {
  if (stocks.length === 0) return "";
  const rows = stocks
    .map((s) => {
      const name = displayName(s);
      const reliability = s.dataQuality?.reliabilityHebrew ?? "";
      return `### ${s.ticker} — ${name}

> ⚠️ **${EMERGENCY_MODE_LABEL}** · ⭐ ${s.finalScore.toFixed(1)}/10 · 🧪 ${dqBadge(s)}

- 💰 ${fmtPrice(s.price)} (${s.price > 0 ? fmtChange(s.changePercent) : "—"})
- ${reliability}`;
    })
    .join("\n\n---\n\n");
  return `## ⚠️ Reduced-Confidence Watch (${stocks.length})

_${EMERGENCY_MODE_EXPLANATION_HEBREW}_

${rows}`;
}

// ---------- 5. Technical Watch ----------

function technicalWatchSection(items: TechnicalWatchItem[], dataUnavailable: boolean): string {
  if (dataUnavailable || items.length === 0) {
    return `## 📊 Technical Watch

_נתונים טכניים (RSI / Bollinger Bands, מחושבים מקומית) אינם זמינים כרגע._`;
  }
  const header =
    "| Symbol | Price | Change | RSI(14) | Status |\n" + "| ------ | ----- | ------ | ------- | ------ |";
  const rows = items.map((i) => {
    const rsi = i.rsi14 !== null ? `${Math.round(i.rsi14)} (${rsiInterpretation(i.rsi14).label})` : "—";
    const priceCell = i.price > 0 ? `${fmtPrice(i.price)}${i.isLastClose ? " (Last close)" : ""}` : "Unavailable";
    const changeCell = i.price > 0 && !i.isLastClose ? fmtChange(i.changePercent) : "—";
    return `| **${i.ticker}** | ${priceCell} | ${changeCell} | ${rsi} | ${i.statusHebrew} |`;
  });
  return `## 📊 Technical Watch

_RSI ורצועות בולינג'ר מחושבים מקומית מנתוני מחיר יומיים (Yahoo Finance) – לא נשלפים מ-Alpha Vantage._

${[header, ...rows].join("\n")}`;
}

// ---------- 5b. Earnings Follow-up ----------

function fmtFollowUpMove(pct: number | null): string {
  if (pct === null) return "Unavailable";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function earningsFollowUpSection(followUp: EarningsFollowUpResult): string {
  if (followUp.entries.length === 0) {
    return `## 📮 Earnings Follow-up

_${earningsFollowUpStatusMessageHebrew(followUp.status)}_`;
  }
  const header = "| Symbol | Report Date | BMO/AMC | Reported | Move Since |\n| ------ | ----------- | ------- | -------- | ---------- |";
  const rows = followUp.entries.slice(0, 12).map((e) => {
    const bmoAmc = e.timeOfDay === "pre-market" ? "🌅 BMO" : e.timeOfDay === "post-market" ? "🌇 AMC" : "Unavailable";
    const reported = e.daysAgo === 0 ? "היום" : e.daysAgo === 1 ? "אתמול" : `לפני ${e.daysAgo} ימים`;
    return `| **${e.ticker}** | ${e.reportDate} | ${bmoAmc} | ${reported} | ${fmtFollowUpMove(e.priceChangeSincePct)} |`;
  });
  return `## 📮 Earnings Follow-up

_מהלך המחיר המשוער מאז מועד הדיווח (מבוסס על ימי מסחר, קירוב)._

${[header, ...rows].join("\n")}`;
}

// ---------- 5c. Dividend Information ----------

function dividendsSection(items: DividendInfoItem[], status: DividendsStatus): string {
  if (items.length === 0) {
    const msg =
      status === "unavailable"
        ? "_לא ניתן היה לאמת נתוני דיבידנד לרשימת המעקב או להזדמנויות המובילות בריצה הזו – פרופיל החברה לא היה זמין מאף ספק, כך שלא ידוע אם קיים דיבידנד._"
        : "_אף אחת מהמניות המדווחות ברשימת המעקב או בהזדמנויות המובילות אינה מחלקת דיבידנד כרגע._";
    return `## 💵 Dividend Information

${msg}`;
  }
  const header = "| Symbol | Div/Share | Yield | Ex-Div Date | Pay Date |\n| ------ | --------- | ----- | ----------- | -------- |";
  const rows = items.map(
    (d) =>
      `| **${d.ticker}** | $${d.dividendPerShare.toFixed(2)} | ${d.dividendYieldPct !== null ? `${d.dividendYieldPct.toFixed(2)}%` : "Unavailable"} | ${d.exDividendDate ?? "Unavailable"} | ${d.dividendDate ?? "Unavailable"} |`
  );
  return `## 💵 Dividend Information

${[header, ...rows].join("\n")}`;
}

// ---------- 6. This Week To Watch (FUTURE events only) ----------

// Earnings not already shown in the Upcoming Earnings Calendar – returns ""
// (section hidden) when there's nothing genuinely forward-looking. Already-
// published macro readings are never shown here – see recentMacroSection.
function weekAheadSection(data: ReportData): string {
  const extraEarnings = weekAheadExtraEarnings(data);
  if (extraEarnings.length === 0) return "";
  const earningsLines = extraEarnings.map((e) => `- **${e.ticker}** — ${e.reportDate}`).join("\n");
  return `## 📅 This Week To Watch

**דיווחי רווחים קרובים:**
${earningsLines}`;
}

// ---------- 6b. Recent Macro Data (already published) ----------

function recentMacroSection(week: WeekAhead): string {
  const econSection =
    week.economicReadings.length > 0
      ? week.economicReadings
          .map((r) => `- **${r.label}:** ${r.value}${r.unit}${r.asOfDate ? ` (${r.asOfDate})` : ""}`)
          .join("\n")
      : "_נתוני מאקרו אחרונים אינם זמינים כרגע._";

  return `## 📅 Recent Macro Data (Already Published)

${econSection}`;
}

// ---------- 7. Compact Data Diagnostics ----------

function diagnosticsSection(data: ReportData): string {
  const { status, scanned, qualified } = data;
  return `## 🧪 Data Diagnostics

Live: ${status.liveCount} · Cached: ${status.cachedCount} · Unavailable: ${status.missingCount} · Scanned: ${scanned} · Qualified: ${qualified}${status.rateLimitHit ? " · ⚠️ Alpha Vantage rate limit hit" : ""}`;
}

// ---------- main report ----------

// Canonical section order shared with the email HTML/text renderers so the
// attachment and the email body can never silently drift apart:
//   1. Upcoming Earnings Calendar
//   2. Next Major Market Catalyst
//   3. Market Story of the Day
//   4. Important Headlines
//   5. Market Overview
//   6. Technical Watch
//   7. Earnings Follow-up
//   8. Top Opportunities
//   9. Dividend Information
//  10. This Week To Watch
//  11. Data Diagnostics
export function generateReport(data: ReportData): string {
  const now = new Date(data.generatedAt);
  const { earningsCalendar, earningsCalendarStatus, marketCatalyst } = data;
  const emergencyWatch = emergencyWatchSection(data.emergencyWatch);

  return `# 📈 דוח מניות למשקיע לטווח ארוך

> **Generated:** ${fmtDateTime(now)}

---

${earningsCalendarSection(earningsCalendar, earningsCalendarStatus)}

---

${marketCatalystSection(marketCatalyst)}

---

${marketStorySection(data.marketStory)}

---

${importantHeadlinesSection(data.additionalHeadlines)}

---

${marketOverviewSection(data.marketOverview)}

---

${technicalWatchSection(data.technicalWatch, data.technicalAlerts.dataUnavailable)}

---

${earningsFollowUpSection(data.earningsFollowUp)}

---

${topOpportunitiesSection(data.topOpportunities, data.opportunityTheses)}
${emergencyWatch ? `\n---\n\n${emergencyWatch}\n` : ""}
---

${dividendsSection(data.dividends, data.dividendsStatus)}

---

${weekAheadSection(data) ? `${weekAheadSection(data)}\n\n---\n\n` : ""}${recentMacroSection(data.weekAhead)}

---

${diagnosticsSection(data)}

---

## Disclaimer

**Research only. Not investment advice.** מסחר במניות כרוך בסיכון לאובדן ההון – כל החלטה על אחריותך בלבד.

_Generated by stock-agent · ${now.toISOString()}_

${fingerprintHtmlComment(data)}
${provenanceHtmlComment(data)}
`;
}

// ===== Diagnostic-only report (Report Quality Score below SEND_THRESHOLD) =====
//
// Rendered INSTEAD of the normal newsletter when quality stayed poor even
// after the recovery pass – see src/reportQuality.ts and pipeline.ts. Never
// pretends to be a normal report: short, explicit about what's missing, and
// built only from data we DO have (Market Overview + Earnings Calendar
// already have their own honest empty/unavailable states).

function providerIssuesSection(data: ReportData): string {
  const failing = data.reportQuality.dimensions.filter((d) => d.scorePct < 60);
  if (failing.length === 0) {
    return `## ⚠️ Provider Issues

_לא זוהה כשל ספק בודד וחמור – הציון ירד משילוב של כמה פערי כיסוי חלקיים, ראו טבלה למטה._`;
  }
  const lines = failing.map((d) => `- **${d.label}**: ${d.scorePct}% (${d.detail})`);
  return `## ⚠️ Provider Issues

${lines.join("\n")}`;
}

function lastVerifiedSection(data: ReportData): string {
  const lines = data.watchlist.map((s) => {
    const src = s.quoteSource;
    const label =
      !src || src.source === "unavailable"
        ? "לא זמין"
        : src.source === "live"
        ? "עדכני (נשלף כעת)"
        : `במטמון (${src.ageHours ?? "?"} שעות)`;
    return `- **${s.ticker}**: ${label}`;
  });
  return `## 🕒 Last Verified Data

${lines.join("\n")}`;
}

export function generateDiagnosticReport(data: ReportData): string {
  const now = new Date(data.generatedAt);
  const q = data.reportQuality;
  return `# 📈 דוח מניות למשקיע לטווח ארוך — מצב מוגבל

> **Generated:** ${fmtDateTime(now)}

---

## ⚠️ הדוח היום לא הופק ברמת האיכות הרגילה

_Today's market report could not be produced at normal quality (Report Quality Score: ${q.score}/100 – ${q.band}). Rather than send a misleading or near-empty newsletter, this is a short diagnostic summary of what we do know right now. The full report resumes automatically once data coverage recovers._

---

${marketOverviewSection(data.marketOverview)}

---

${earningsCalendarSection(data.earningsCalendar, data.earningsCalendarStatus)}

---

${providerIssuesSection(data)}

---

${lastVerifiedSection(data)}

---

${diagnosticsSection(data)}

---

## Disclaimer

**Research only. Not investment advice.** מסחר במניות כרוך בסיכון לאובדן ההון – כל החלטה על אחריותך בלבד.

_Generated by stock-agent · ${now.toISOString()}_

${fingerprintHtmlComment(data)}
${provenanceHtmlComment(data)}
`;
}

export function writeReport(content: string, outDir = "reports"): string {
  const fullDir = path.resolve(process.cwd(), outDir);
  if (!fs.existsSync(fullDir)) fs.mkdirSync(fullDir, { recursive: true });
  const filePath = path.join(fullDir, "daily-stock-report.md");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

// exported for reuse by htmlReportGenerator.ts and tests
export { fmtNum, fmtChange, fmtPrice, fmtDateTime, dqBadge, displayName };
