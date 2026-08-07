import fs from "fs";
import path from "path";
import { earningsCalendarStatusMessageHebrew } from "./earningsCalendar";
import { earningsFollowUpStatusMessageHebrew } from "./earningsFollowUp";
import { EMERGENCY_MODE_LABEL, EMERGENCY_MODE_EXPLANATION_HEBREW } from "./emergencyMode";
import { marketCatalystStatusMessageHebrew } from "./marketCatalyst";
import { MIN_VISIBLE_INDICATORS, visibleOverviewItems } from "./marketOverview";
import {
  catalystWhyItMattersHebrew,
  dataFreshnessLine,
  daysRemainingLabelHebrew,
  earningsDateBadgeTone,
  formatOverviewValue,
  ltr,
  ltrTagged,
  riskLevelHebrew,
  sentimentTone,
  weekAheadExtraEarnings,
} from "./reportPresentation";
import { fingerprintHtmlComment, provenanceHtmlComment } from "./reportFingerprint";
import { rsiInterpretation } from "./technicals";
import { watchlistName } from "./universe";
import {
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
} from "./types";

// ===== helpers =====

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtChange(pct: number): string {
  return pct >= 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`;
}

function changeClass(pct: number): string {
  if (pct > 0) return "up";
  if (pct < 0) return "down";
  return "flat";
}

function fmtPrice(p: number): string {
  return p > 0 ? `$${p.toFixed(2)}` : "";
}

function fmtDateTime(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function displayName(s: EnrichedStock): string {
  return s.profile?.name ?? watchlistName(s.ticker) ?? s.ticker;
}

// ===== 0. Header =====

function renderSentimentBadge(fearGreed: ReportData["fearGreed"]): string {
  if (!fearGreed) {
    return `<span class="badge badge-neutral">Sentiment: Unavailable</span>`;
  }
  const tone = sentimentTone(fearGreed.score);
  return `<span class="badge badge-${tone}">Sentiment: ${esc(fearGreed.classification)} (${fearGreed.score})</span>`;
}

function renderHeader(now: Date, data: ReportData): string {
  return `
  <header class="report-header">
    <div class="report-header-inner">
      <h1>Daily Market Report</h1>
      <p class="report-date">${esc(fmtDate(now))}</p>
      <div class="header-meta">
        ${renderSentimentBadge(data.fearGreed)}
        <span class="freshness-line">${esc(dataFreshnessLine(data.status))}</span>
      </div>
    </div>
  </header>`;
}

// ===== 1. Upcoming Earnings Calendar =====

const URGENCY_EMOJI: Record<EarningsUrgency, string> = {
  today: "🔴",
  tomorrow: "🟠",
  week: "🟡",
  later: "⚪",
};

function renderEarningsCalendar(
  entries: EarningsCalendarEntry[],
  status: EarningsCalendarStatus
): string {
  if (entries.length === 0) {
    return `
  <section>
    <h2 class="section-title">Upcoming Earnings Calendar</h2>
    <p class="empty">${esc(earningsCalendarStatusMessageHebrew(status))}</p>
  </section>`;
  }

  const rows = entries
    .slice(0, 12)
    .map((e) => {
      const eps = e.estimatedEps !== undefined ? `$${e.estimatedEps.toFixed(2)}` : "Unavailable";
      const bmoAmc =
        e.timeOfDay === "pre-market" ? "Pre-Market" : e.timeOfDay === "post-market" ? "After Market" : "Unavailable";
      const tone = earningsDateBadgeTone(e.daysRemaining);
      return `
        <tr class="earnings-row">
          <td class="symbol">${ltr(esc(e.ticker))}<span class="alert-name">${esc(e.name)}</span></td>
          <td>${ltr(esc(e.reportDate))}</td>
          <td class="metric-sub">${esc(bmoAmc)}</td>
          <td><span class="date-badge date-badge-${tone}">${esc(daysRemainingLabelHebrew(e.daysRemaining))}</span></td>
          <td>${ltr(esc(eps))}</td>
          <td class="why-cell">${esc(e.reasonsHebrew.join(" · "))}</td>
        </tr>`;
    })
    .join("");

  return `
  <section>
    <h2 class="section-title">Upcoming Earnings Calendar</h2>
    <div class="table-wrap card">
      <table class="report-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Date</th>
            <th>Time</th>
            <th>Days Remaining</th>
            <th>EPS Est.</th>
            <th>למה זה חשוב</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

// ===== 2. Next Major Market Catalyst =====

function renderMarketCatalyst(catalyst: MarketCatalystResult): string {
  if (!catalyst.catalyst) {
    return `
  <section>
    <h2 class="section-title">Next Major Market Catalyst</h2>
    <p class="empty">${esc(marketCatalystStatusMessageHebrew(catalyst.status))}</p>
  </section>`;
  }
  const c = catalyst.catalyst;
  return `
  <section>
    <h2 class="section-title">Next Major Market Catalyst</h2>
    <article class="card catalyst-card">
      <p class="catalyst-timing">${esc(c.timingHebrew)} · ${ltr(esc(c.reportDate))}</p>
      <h3 class="catalyst-headline">${esc(c.headline)}</h3>
      <p class="catalyst-meta">${ltr(esc(c.ticker))}</p>
      <p class="catalyst-why">${esc(catalystWhyItMattersHebrew(c.ticker))}</p>
    </article>
  </section>`;
}

// ===== 3. Market Story of the Day =====

function renderStoryVisual(story: MarketStory): string {
  if (story.logoUrl) {
    return `<div class="story-visual">
        <img class="story-logo" src="${esc(story.logoUrl)}" alt="${esc(story.companyName)} logo" loading="lazy" referrerpolicy="no-referrer">
      </div>`;
  }
  return `<div class="story-visual">
        <div class="ticker-placeholder" role="img" aria-label="${esc(story.ticker)}">
          <span class="ticker-symbol">${ltr(esc(story.ticker))}</span>
        </div>
      </div>`;
}

function renderMarketStory(story: MarketStory | null): string {
  if (!story) {
    return `
  <section>
    <h2 class="section-title">Market Story of the Day</h2>
    <article class="card story-card empty-story">
      <p class="empty">לא נמצאה ידיעה חדשותית מהותית היום.</p>
    </article>
  </section>`;
  }

  const moveHtml =
    story.priceMove && story.priceMove.price > 0
      ? `<span class="story-move ${changeClass(story.priceMove.changePercent)}">${ltr(esc(fmtPrice(story.priceMove.price)))} · ${ltr(esc(fmtChange(story.priceMove.changePercent)))}</span>`
      : "";
  const sentimentHtml = story.sentimentLabel ? `<span class="story-chip">${esc(story.sentimentLabel)}</span>` : "";

  return `
  <section>
    <h2 class="section-title">Market Story of the Day</h2>
    <article class="card story-card">
      ${renderStoryVisual(story)}
      <div class="story-body">
        <div class="story-tags">
          <span class="story-ticker">${ltr(esc(story.ticker))}</span>
          <span class="story-company">${esc(story.companyName)}</span>
          ${sentimentHtml}
          ${moveHtml}
        </div>
        <h3 class="story-headline">${ltr(esc(story.headline))}</h3>
        <p class="story-meta">${esc(story.source)} · ${ltr(esc(story.publishedDisplay))}</p>
        <div class="story-block">
          <h4>מה קרה</h4>
          <p>${esc(story.summaryHebrew)}</p>
        </div>
        <div class="story-block">
          <h4>למה זה חשוב</h4>
          <p>${esc(story.whyMattersHebrew)}</p>
        </div>
        <a class="btn-link" href="${esc(story.url)}" target="_blank" rel="noopener noreferrer">Read full article</a>
      </div>
    </article>
  </section>`;
}

// ===== 4. Important Headlines =====

function renderImportantHeadlines(items: MarketStory[]): string {
  if (items.length === 0) {
    return `
  <section>
    <h2 class="section-title">Important Headlines</h2>
    <p class="empty">אין כותרות נוספות מהותיות היום מעבר לידיעה הראשית.</p>
  </section>`;
  }
  const cards = items
    .map(
      (a) => `
      <article class="card headline-card">
        <div class="headline-top">
          <span class="story-ticker">${ltr(esc(a.ticker))}</span>
          <span class="story-company">${esc(a.companyName)}</span>
        </div>
        <p class="headline-text">${ltr(esc(a.headline))}</p>
        <p class="metric-sub">${esc(a.source)}</p>
      </article>`
    )
    .join("");
  return `
  <section>
    <h2 class="section-title">Important Headlines</h2>
    <div class="headline-grid">${cards}</div>
  </section>`;
}

// ===== 5. Market Overview =====

function renderMarketOverview(items: MarketOverviewItem[]): string {
  const visible = visibleOverviewItems(items);

  if (visible.length < MIN_VISIBLE_INDICATORS) {
    return `
  <section>
    <h2 class="section-title">Market Overview</h2>
    <p class="empty">נתוני שוק כלליים אינם זמינים מספיק כרגע (${visible.length}/${items.length} מדדים בלבד) – הסעיף יתעדכן כשהמקור יחזור להיות זמין.</p>
  </section>`;
  }

  const tiles = visible
    .map((i) => {
      const value = formatOverviewValue(i);
      const change =
        i.changePercent !== null
          ? `<span class="tile-change ${changeClass(i.changePercent)}">${ltr(esc(fmtChange(i.changePercent)))}</span>`
          : "";
      return `
        <div class="overview-tile" data-metric-key="${esc(i.key)}">
          <span class="tile-label">${esc(i.label)}</span>
          <span class="tile-value">${ltrTagged(esc(value), `data-metric-value-key="${esc(i.key)}"`)}</span>
          ${change}
        </div>`;
    })
    .join("");

  return `
  <section>
    <h2 class="section-title">Market Overview</h2>
    <div class="overview-grid">${tiles}</div>
  </section>`;
}

// ===== 6. Technical Watch =====

function rsiTone(rsi: number): string {
  if (rsi > 70) return "overbought";
  if (rsi >= 60) return "strong";
  if (rsi >= 40) return "neutral";
  if (rsi >= 30) return "weak";
  return "oversold";
}

function renderTechnicalWatch(items: TechnicalWatchItem[], dataUnavailable: boolean): string {
  if (dataUnavailable || items.length === 0) {
    return `
  <section>
    <h2 class="section-title">Technical Watch</h2>
    <p class="empty">נתונים טכניים (RSI / Bollinger Bands, מחושבים מקומית) אינם זמינים כרגע.</p>
  </section>`;
  }

  const rows = items
    .map((i) => {
      const hasPrice = i.price > 0;
      const rsiHtml =
        i.rsi14 !== null
          ? `<span class="rsi-badge ${rsiTone(i.rsi14)}">${Math.round(i.rsi14)}</span>`
          : "—";
      const priceCell = hasPrice
        ? `${ltr(esc(fmtPrice(i.price)))}${i.isLastClose ? ` <span class="alert-name">(Last close)</span>` : ""}`
        : `<span class="muted-text">Price unavailable</span>`;
      return `
        <tr class="${hasPrice ? "" : "row-muted"}">
          <td class="symbol">${ltr(esc(i.ticker))}<span class="alert-name">${esc(i.name)}</span></td>
          <td>${priceCell}</td>
          <td>${rsiHtml}</td>
          <td><span class="signal-badge">${esc(i.statusHebrew)}</span></td>
        </tr>`;
    })
    .join("");

  return `
  <section>
    <h2 class="section-title">Technical Watch</h2>
    <p class="section-subtitle">RSI ורצועות בולינג'ר מחושבים מקומית מנתוני מחיר יומיים (Yahoo Finance).</p>
    <div class="table-wrap card">
      <table class="report-table">
        <thead>
          <tr><th>Ticker</th><th>Price</th><th>RSI</th><th>Signal</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

// ===== 7. Earnings Follow-up =====

function fmtFollowUpMove(pct: number | null): string {
  if (pct === null) return "Unavailable";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function renderEarningsFollowUp(followUp: EarningsFollowUpResult): string {
  if (followUp.entries.length === 0) {
    return `
  <section>
    <h2 class="section-title">Earnings Follow-up</h2>
    <p class="empty">${esc(earningsFollowUpStatusMessageHebrew(followUp.status))}</p>
  </section>`;
  }

  const rows = followUp.entries
    .slice(0, 12)
    .map((e) => {
      const moveClass = e.priceChangeSincePct === null ? "flat" : changeClass(e.priceChangeSincePct);
      return `
        <tr>
          <td class="symbol">${ltr(esc(e.ticker))}<span class="alert-name">${esc(e.name)}</span></td>
          <td>${ltr(esc(e.reportDate))}</td>
          <td class="${moveClass}">${ltr(esc(fmtFollowUpMove(e.priceChangeSincePct)))}</td>
        </tr>`;
    })
    .join("");

  return `
  <section>
    <h2 class="section-title">Earnings Follow-up</h2>
    <div class="table-wrap card">
      <table class="report-table">
        <thead>
          <tr><th>Company</th><th>Earnings Date</th><th>Price Reaction</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

// ===== 8. Top Opportunities =====

function scoreTier(score: number): { cls: string; label: string } {
  if (score >= 8) return { cls: "strong", label: "Strong" };
  if (score >= 6) return { cls: "watchlist", label: "Watchlist" };
  return { cls: "cautious", label: "Cautious" };
}

function metricChip(label: string, value: string): string {
  return `
        <div class="metric-chip">
          <span class="metric-chip-label">${esc(label)}</span>
          <span class="metric-chip-value">${esc(value)}</span>
        </div>`;
}

function renderOpportunityCard(rank: number, s: EnrichedStock, thesis: OpportunityThesis | undefined): string {
  const tier = scoreTier(s.finalScore);
  const name = displayName(s);
  const dq = s.dataQuality;

  const primaryField = (label: string, value: string) => `
      <div class="opp-section opp-section-primary">
        <h4>${esc(label)}</h4>
        <p>${esc(value)}</p>
      </div>`;
  const secondaryField = (label: string, value: string) => `
      <div class="opp-section opp-section-secondary">
        <h4>${esc(label)}</h4>
        <p>${esc(value)}</p>
      </div>`;

  return `
    <article class="opportunity-card card ${tier.cls}">
      <div class="opp-head">
        <div class="opp-id">
          <span class="rank-chip">#${rank}</span>
          <div>
            <h3 class="ticker">${ltr(esc(s.ticker))}</h3>
            <p class="company">${esc(name)}</p>
          </div>
        </div>
        <div class="opp-head-right">
          <div class="score-badge ${tier.cls}">
            <span class="score-num">${s.finalScore.toFixed(1)}</span>
            <span class="score-denom">/10</span>
          </div>
          ${s.price > 0 ? `<span class="metric-value ${changeClass(s.changePercent)}">${ltr(esc(fmtChange(s.changePercent)))}</span>` : ""}
        </div>
      </div>

      <div class="metrics-row">
        ${metricChip("Coverage", dq ? `${dq.coverageScore}` : "—")}
        ${metricChip("Confidence", dq ? `${dq.confidenceScore}` : "—")}
        ${metricChip("Risk Level", riskLevelHebrew(s.tier))}
      </div>

      ${primaryField("למה עכשיו", thesis?.whyToday ?? s.whyHebrew)}
      ${primaryField("קטליזטור קרוב", thesis?.catalyst ?? "—")}
      ${primaryField("סיכון מרכזי", thesis?.mainRisk ?? "—")}
      ${secondaryField("מה השתנה לאחרונה", thesis?.whatChanged ?? "—")}
      ${secondaryField("מדדים מרכזיים", thesis?.keyMetric ?? "—")}
      ${secondaryField("מה יפריך את התזה", thesis?.invalidation ?? "—")}
    </article>`;
}

// Top Opportunities NEVER contains an Emergency-Mode-promoted stock – when
// nothing clears the normal bar this simply shows fewer than 3 (down to 0)
// rather than backfilling. See renderEmergencyWatch below for where those go.
function renderTopOpportunities(stocks: EnrichedStock[], theses: Map<string, OpportunityThesis>): string {
  const inner =
    stocks.length > 0
      ? `<div class="opportunities">${stocks.map((s, idx) => renderOpportunityCard(idx + 1, s, theses.get(s.ticker))).join("\n")}</div>`
      : `<p class="empty">אין הזדמנויות שעברו את סף איכות הנתונים בריצה הזו.</p>`;
  return `
  <section>
    <h2 class="section-title">Top Opportunities</h2>
    ${inner}
  </section>`;
}

// ===== 8b. Reduced-Confidence Watch (Emergency Report Mode only) =====
//
// Renders nothing at all when Emergency Mode isn't engaged – this block only
// exists on the days it's actually needed. Deliberately the muted/"cautious"
// tier styling regardless of score, plus an explicit badge, so it can never
// visually read as a normal (green/strong) Top Opportunity.
function renderEmergencyWatchCard(s: EnrichedStock): string {
  const name = displayName(s);
  const dq = s.dataQuality;
  return `
    <article class="opportunity-card card cautious">
      <div class="opp-head">
        <div class="opp-id">
          <div>
            <h3 class="ticker">${ltr(esc(s.ticker))}</h3>
            <p class="company">${esc(name)}</p>
          </div>
        </div>
        <div class="opp-head-right">
          <div class="score-badge cautious">
            <span class="score-num">${s.finalScore.toFixed(1)}</span>
            <span class="score-denom">/10</span>
          </div>
          ${s.price > 0 ? `<span class="metric-value ${changeClass(s.changePercent)}">${ltr(esc(fmtChange(s.changePercent)))}</span>` : ""}
        </div>
      </div>
      <div style="margin:8px 0 0;padding:4px 10px;border-radius:6px;background:#fef3c7;color:#92400e;font-weight:800;font-size:11.5px;display:inline-block;">⚠️ ${EMERGENCY_MODE_LABEL}</div>
      <div class="metrics-row">
        ${metricChip("Coverage", dq ? `${dq.coverageScore}` : "—")}
        ${metricChip("Confidence", dq ? `${dq.confidenceScore}` : "—")}
      </div>
      <p style="margin-top:10px;font-size:12.5px;color:var(--muted);">${esc(dq?.reliabilityHebrew ?? "")}</p>
    </article>`;
}

function renderEmergencyWatch(stocks: EnrichedStock[]): string {
  if (stocks.length === 0) return "";
  return `
  <section>
    <h2 class="section-title">⚠️ Reduced-Confidence Watch</h2>
    <p class="empty" style="margin-bottom:14px;">${esc(EMERGENCY_MODE_EXPLANATION_HEBREW)}</p>
    <div class="opportunities">${stocks.map((s) => renderEmergencyWatchCard(s)).join("\n")}</div>
  </section>`;
}

// ===== 9. Dividend Information (secondary, visually smaller) =====

function renderDividends(items: DividendInfoItem[], status: DividendsStatus): string {
  if (items.length === 0) {
    const msg =
      status === "unavailable"
        ? "לא ניתן היה לאמת נתוני דיבידנד בריצה הזו – פרופיל החברה לא היה זמין מאף ספק."
        : "אף אחת מהמניות המדווחות אינה מחלקת דיבידנד כרגע.";
    return `
  <section class="secondary-section">
    <h3 class="section-title-sm">Dividend Information</h3>
    <p class="empty empty-sm">${msg}</p>
  </section>`;
  }

  const rows = items
    .map(
      (d) => `
        <tr>
          <td class="symbol">${ltr(esc(d.ticker))}</td>
          <td>${ltr(esc(`$${d.dividendPerShare.toFixed(2)}`))}</td>
          <td>${d.dividendYieldPct !== null ? ltr(esc(`${d.dividendYieldPct.toFixed(2)}%`)) : "Unavailable"}</td>
        </tr>`
    )
    .join("");

  return `
  <section class="secondary-section">
    <h3 class="section-title-sm">Dividend Information</h3>
    <div class="table-wrap card card-sm">
      <table class="report-table report-table-sm">
        <thead>
          <tr><th>Ticker</th><th>Annual Dividend</th><th>Yield</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

// ===== 10. This Week To Watch – macro only; the earnings sub-list is shown
// ONLY when it has entries beyond what Upcoming Earnings Calendar already
// displayed (never a bare repeat of the same information). =====

function renderWeekAhead(data: ReportData): string {
  const { weekAhead } = data;
  const extraEarnings = weekAheadExtraEarnings(data);

  const earningsHtml =
    extraEarnings.length > 0
      ? `<ul class="week-list week-ahead-earnings">${extraEarnings.map((e) => `<li><strong>${ltr(esc(e.ticker))}</strong> — ${ltr(esc(e.reportDate))}</li>`).join("")}</ul>`
      : "";

  const econHtml =
    weekAhead.economicReadings.length > 0
      ? `<ul class="week-list">${weekAhead.economicReadings
          .map((r) => `<li><strong>${esc(r.label)}:</strong> ${ltr(esc(String(r.value) + r.unit))}${r.asOfDate ? ` (${ltr(esc(r.asOfDate))})` : ""}</li>`)
          .join("")}</ul>`
      : `<p class="empty empty-sm">נתוני מאקרו אחרונים אינם זמינים כרגע.</p>`;

  return `
  <section class="secondary-section">
    <h3 class="section-title-sm">This Week To Watch</h3>
    <div class="card card-sm">
      ${extraEarnings.length > 0 ? `<h4>דיווחי רווחים נוספים</h4>${earningsHtml}` : ""}
      <h4>מאקרו (נתונים שכבר פורסמו)</h4>
      ${econHtml}
    </div>
  </section>`;
}

// ===== 11. Data Diagnostics (bottom, muted) =====

function renderDiagnostics(data: ReportData): string {
  const { status, scanned, qualified } = data;
  return `
  <section>
    <div class="diagnostics-card">
      <span class="diagnostics-label">Data quality</span>
      <span>${status.liveCount} Live · ${status.cachedCount} Cached · ${status.missingCount} Unavailable</span>
      <span class="metric-sub">${scanned} scanned · ${qualified} qualified</span>
    </div>
    ${status.rateLimitHit ? `<p class="rate-limit-notice">⚠️ Alpha Vantage rate limit hit during this run.</p>` : ""}
  </section>`;
}

function renderDisclaimer(generatedAt: string): string {
  return `
  <footer class="disclaimer">
    <p><strong>Research only. Not investment advice.</strong> מסחר במניות כרוך בסיכון לאובדן ההון – כל החלטה על אחריותך בלבד.</p>
    <p class="attachments-line">קבצים מצורפים: daily-stock-report.html · daily-stock-report.md</p>
    <p class="generated">Generated by stock-agent · ${esc(generatedAt)}</p>
  </footer>`;
}

// ===== CSS =====

const CSS = `
  :root {
    --navy: #0f172a;
    --navy-2: #1e3a8a;
    --page-bg: #eef2f7;
    --card-bg: #ffffff;
    --border: #e2e8f0;
    --text: #0f172a;
    --muted: #64748b;
    --muted-soft: #94a3b8;
    --green: #0f9d58;
    --green-soft: #e6f4ea;
    --amber: #b45309;
    --amber-soft: #fef3e2;
    --red: #d93025;
    --red-soft: #fce8e6;
    --blue: #2563eb;
    --blue-soft: #e8f0fe;
    --shadow: 0 1px 2px rgba(15,23,42,.05), 0 2px 8px rgba(15,23,42,.05);
    --radius: 12px;
    --radius-sm: 8px;
  }

  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--page-bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Heebo",
                 "Rubik", "Assistant", Arial, sans-serif;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .container {
    max-width: 760px;
    margin: 0 auto;
    padding: 0 20px 60px;
  }

  /* ===== Header ===== */
  .report-header {
    background: var(--navy);
    color: #fff;
    padding: 28px 0;
    margin-bottom: 28px;
  }
  .report-header-inner {
    max-width: 760px;
    margin: 0 auto;
    padding: 0 20px;
  }
  .report-header h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.01em;
  }
  .report-date {
    margin: 4px 0 14px;
    color: rgba(255,255,255,.75);
    font-size: 14px;
  }
  .header-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 16px;
  }
  .freshness-line {
    font-size: 13px;
    color: rgba(255,255,255,.85);
  }

  /* ===== Badges (sentiment) ===== */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 4px 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
  }
  .badge-neutral { background: rgba(255,255,255,.14); color: #fff; }
  .badge-extreme-fear { background: var(--red-soft); color: #991b1b; }
  .badge-fear { background: var(--amber-soft); color: #92400e; }
  .badge-greed { background: var(--green-soft); color: #065f46; }
  .badge-extreme-greed { background: var(--green-soft); color: #064e3b; }

  /* ===== Generic layout ===== */
  section { margin-bottom: 28px; }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
    box-shadow: var(--shadow);
  }
  .card-sm { padding: 14px 16px; }
  .section-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--navy);
    margin: 0 0 12px;
  }
  .section-title-sm {
    font-size: 15px;
    font-weight: 700;
    color: var(--muted);
    margin: 0 0 8px;
    text-transform: uppercase;
    letter-spacing: .03em;
  }
  .section-subtitle {
    margin: -6px 0 12px;
    color: var(--muted);
    font-size: 13px;
  }
  .empty {
    color: var(--muted);
    background: var(--card-bg);
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    padding: 14px 16px;
  }
  .empty-sm { padding: 10px 14px; font-size: 13px; }
  .secondary-section { opacity: .92; }

  /* ===== Tables ===== */
  .table-wrap { padding: 0; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table.report-table { width: 100%; border-collapse: collapse; min-width: 460px; }
  .report-table-sm { min-width: 320px; }
  table.report-table th,
  table.report-table td {
    text-align: start;
    padding: 10px 14px;
    font-size: 13.5px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  table.report-table thead th {
    background: var(--page-bg);
    color: var(--muted);
    font-weight: 600;
    font-size: 11px;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  table.report-table tbody tr:last-child td { border-bottom: 0; }
  table.report-table tbody tr.row-muted { color: var(--muted-soft); }
  td.symbol { font-weight: 700; color: var(--navy); }
  .up { color: var(--green); font-weight: 700; }
  .down { color: var(--red); font-weight: 700; }
  .flat { color: var(--muted); }
  .muted-text { color: var(--muted-soft); font-style: italic; }
  .alert-name { display: block; font-size: 11.5px; font-weight: 500; color: var(--muted); }
  .why-cell { white-space: normal; min-width: 200px; font-size: 12.5px; color: var(--muted); }

  /* ===== Date badges ===== */
  .date-badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
  }
  .date-badge-today { background: var(--red-soft); color: #991b1b; }
  .date-badge-tomorrow { background: var(--amber-soft); color: #92400e; }
  .date-badge-soon { background: var(--amber-soft); color: #92400e; opacity: .85; }
  .date-badge-later { background: var(--blue-soft); color: var(--navy-2); }

  /* ===== Catalyst card ===== */
  .catalyst-card { border-right: 4px solid var(--red); background: linear-gradient(135deg, var(--red-soft), var(--card-bg)); }
  .catalyst-timing { margin: 0 0 4px; font-weight: 700; color: #991b1b; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .catalyst-headline { margin: 0 0 6px; font-size: 20px; color: var(--navy); }
  .catalyst-meta { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
  .catalyst-why { margin: 0; font-size: 14px; color: var(--text); }

  /* ===== Market Story ===== */
  .story-card { display: flex; gap: 18px; align-items: stretch; }
  .story-card.empty-story { display: block; }
  .story-visual { flex: 0 0 100px; display: flex; align-items: center; justify-content: center; }
  .story-logo { max-width: 96px; max-height: 72px; object-fit: contain; border-radius: var(--radius-sm); background: #fff; padding: 6px; }
  .ticker-placeholder {
    width: 96px; height: 72px; border-radius: var(--radius-sm);
    background: var(--navy); color: #fff;
    display: flex; align-items: center; justify-content: center;
  }
  .ticker-symbol { font-size: 20px; font-weight: 800; }
  .story-body { flex: 1 1 auto; min-width: 0; }
  .story-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
  .story-ticker { background: var(--navy); color: #fff; font-weight: 800; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .story-company { color: var(--muted); font-size: 13px; font-weight: 600; }
  .story-chip { background: var(--page-bg); color: var(--navy-2); font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
  .story-move { font-size: 12.5px; font-weight: 700; }
  .story-headline { margin: 2px 0 6px; font-size: 17px; font-weight: 700; color: var(--navy); line-height: 1.3; }
  .story-meta { margin: 0 0 10px; font-size: 12.5px; color: var(--muted); }
  .story-block { margin-bottom: 8px; }
  .story-block h4 { margin: 0 0 2px; font-size: 12.5px; font-weight: 700; color: var(--navy); }
  .story-block p { margin: 0; font-size: 14px; color: var(--text); }
  .btn-link {
    display: inline-block; margin-top: 6px;
    font-weight: 700; font-size: 13px; color: #fff;
    background: var(--navy-2); text-decoration: none;
    padding: 8px 16px; border-radius: 999px;
  }

  /* ===== Headline cards ===== */
  .headline-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .headline-card { padding: 14px 16px; }
  .headline-top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .headline-text { margin: 0 0 4px; font-size: 13.5px; color: var(--text); }

  /* ===== Market Overview tiles ===== */
  .overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .overview-tile {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 12px 14px; display: flex; flex-direction: column; gap: 3px;
    box-shadow: var(--shadow);
  }
  .tile-label { font-size: 11.5px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .02em; }
  .tile-value { font-size: 18px; font-weight: 800; color: var(--navy); }
  .tile-change { font-size: 12.5px; font-weight: 700; }

  /* ===== RSI / signal badges ===== */
  .rsi-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 700; background: var(--page-bg); color: var(--muted); }
  .rsi-badge.overbought { background: var(--red-soft); color: #991b1b; }
  .rsi-badge.strong { background: var(--green-soft); color: #065f46; }
  .rsi-badge.neutral { background: var(--page-bg); color: var(--muted); }
  .rsi-badge.weak { background: var(--amber-soft); color: #92400e; }
  .rsi-badge.oversold { background: var(--blue-soft); color: var(--navy-2); }
  .signal-badge { font-size: 12.5px; color: var(--text); }

  /* ===== Opportunity cards ===== */
  .opportunities { display: flex; flex-direction: column; gap: 16px; }
  .opportunity-card { border-right: 4px solid var(--blue); padding: 20px; }
  .opportunity-card.strong { border-right-color: var(--green); }
  .opportunity-card.watchlist { border-right-color: var(--amber); }
  .opportunity-card.cautious { border-right-color: var(--muted); }
  .opp-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
  .opp-id { display: flex; align-items: flex-start; gap: 10px; }
  .rank-chip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 999px;
    background: var(--page-bg); color: var(--muted); font-weight: 800; font-size: 12px;
    flex-shrink: 0;
  }
  .opp-id h3.ticker { margin: 0; font-size: 20px; font-weight: 800; color: var(--navy); }
  .opp-id p.company { margin: 1px 0 0; color: var(--muted); font-size: 13px; }
  .opp-head-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .score-badge {
    display: flex; align-items: baseline; gap: 2px;
    padding: 4px 12px; border-radius: 999px;
    background: var(--page-bg); color: var(--muted); font-weight: 800;
  }
  .score-badge.strong { background: var(--green-soft); color: #065f46; }
  .score-badge.watchlist { background: var(--amber-soft); color: #92400e; }
  .score-badge.cautious { background: var(--page-bg); color: var(--muted); }
  .score-num { font-size: 17px; }
  .score-denom { font-size: 11px; opacity: .8; }
  .metric-value { font-size: 13px; font-weight: 700; }

  .metrics-row { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
  .metric-chip {
    background: var(--page-bg); border-radius: var(--radius-sm);
    padding: 6px 12px; display: flex; flex-direction: column; gap: 2px; min-width: 84px;
  }
  .metric-chip-label { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
  .metric-chip-value { font-size: 14px; font-weight: 700; color: var(--navy); }

  .opp-section { margin-top: 10px; }
  .opp-section h4 { margin: 0 0 3px; font-size: 13px; font-weight: 700; color: var(--navy); }
  .opp-section p { margin: 0; color: var(--text); font-size: 13.5px; }
  .opp-section-primary p { font-weight: 500; }
  .opp-section-secondary { opacity: .78; }
  .opp-section-secondary h4 { font-size: 12px; color: var(--muted); }
  .opp-section-secondary p { font-size: 12.5px; }

  /* ===== Diagnostics (muted, bottom) ===== */
  .diagnostics-card {
    display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center;
    background: var(--page-bg); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 12px 16px; color: var(--muted); font-size: 13px;
  }
  .diagnostics-label { font-weight: 700; color: var(--navy); }
  .rate-limit-notice {
    margin: 8px 0 0; background: var(--amber-soft); color: #92400e;
    border-radius: var(--radius-sm); padding: 8px 14px; font-size: 12.5px;
  }

  /* ===== Footer / disclaimer ===== */
  .disclaimer {
    margin-top: 32px; padding-top: 18px; border-top: 1px solid var(--border);
    color: var(--muted); font-size: 12px;
  }
  .disclaimer p { margin: 4px 0; }
  .attachments-line { color: var(--muted-soft); }
  .disclaimer .generated { color: var(--muted-soft); }

  .metric-sub { font-size: 12px; color: var(--muted); font-weight: 500; }
  .week-list { margin: 6px 0 14px; padding-inline-start: 20px; font-size: 13.5px; line-height: 1.7; }

  /* ===== Mobile ===== */
  @media (max-width: 640px) {
    .container { padding: 0 14px 40px; }
    .report-header-inner { padding: 0 14px; }
    .card, .opportunity-card { padding: 14px; }
    .opp-head { flex-direction: column; align-items: stretch; }
    .opp-head-right { align-items: flex-start; }
    .story-card { flex-direction: column; }
  }
`;

// ===== top-level renderer =====

// Canonical section order shared with the email HTML renderer so the
// attachment and the email body can never silently drift apart:
//   1. Header
//   2. Upcoming Earnings Calendar
//   3. Next Major Market Catalyst
//   4. Market Story of the Day
//   5. Important Headlines
//   6. Market Overview
//   7. Technical Watch
//   8. Earnings Follow-up
//   9. Top Opportunities
//  10. Dividend Information
//  11. This Week To Watch (macro only – earnings sub-list omitted when it
//      would only repeat the Upcoming Earnings Calendar)
//  12. Data Diagnostics + attachments/disclaimer footer
export function generateHtmlReport(data: ReportData): string {
  const now = new Date(data.generatedAt);
  const {
    earningsCalendar,
    earningsCalendarStatus,
    marketCatalyst,
    marketOverview,
    topOpportunities,
    emergencyWatch,
    opportunityTheses,
    technicalWatch,
    technicalAlerts,
    earningsFollowUp,
    dividends,
    dividendsStatus,
  } = data;

  const body = [
    renderHeader(now, data),
    `<main class="container" dir="rtl">`,
    renderEarningsCalendar(earningsCalendar, earningsCalendarStatus),
    renderMarketCatalyst(marketCatalyst),
    renderMarketStory(data.marketStory),
    renderImportantHeadlines(data.additionalHeadlines),
    renderMarketOverview(marketOverview),
    renderTechnicalWatch(technicalWatch, technicalAlerts.dataUnavailable),
    renderEarningsFollowUp(earningsFollowUp),
    renderTopOpportunities(topOpportunities, opportunityTheses),
    renderEmergencyWatch(emergencyWatch),
    renderDividends(dividends, dividendsStatus),
    renderWeekAhead(data),
    renderDiagnostics(data),
    renderDisclaimer(data.generatedAt),
    `</main>`,
    fingerprintHtmlComment(data),
    provenanceHtmlComment(data),
  ].join("\n");

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Market Report – ${esc(fmtDateTime(now))}</title>
  <style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ===== Diagnostic-only report (Report Quality Score below SEND_THRESHOLD) =====
//
// Rendered INSTEAD of the normal newsletter when quality stayed poor even
// after the recovery pass – see src/reportQuality.ts and pipeline.ts. Reuses
// the same header/CSS shell as the normal report (same visual system, per
// the approved design), just with a short, honest body instead of the full
// section set.

function renderProviderIssues(data: ReportData): string {
  const failing = data.reportQuality.dimensions.filter((d) => d.scorePct < 60);
  const rows =
    failing.length > 0
      ? failing.map((d) => `<li><strong>${esc(d.label)}</strong>: ${d.scorePct}% (${esc(d.detail)})</li>`).join("")
      : `<li>לא זוהה כשל ספק בודד וחמור – הציון ירד משילוב של כמה פערי כיסוי חלקיים.</li>`;
  return `
  <section>
    <h2 class="section-title">⚠️ Provider Issues</h2>
    <div class="card"><ul style="margin:0;padding-inline-start:20px;">${rows}</ul></div>
  </section>`;
}

function renderLastVerified(data: ReportData): string {
  const rows = data.watchlist
    .map((s) => {
      const src = s.quoteSource;
      const label =
        !src || src.source === "unavailable"
          ? "לא זמין"
          : src.source === "live"
          ? "עדכני (נשלף כעת)"
          : `במטמון (${src.ageHours ?? "?"} שעות)`;
      return `<li><strong>${ltr(esc(s.ticker))}</strong>: ${esc(label)}</li>`;
    })
    .join("");
  return `
  <section>
    <h2 class="section-title">🕒 Last Verified Data</h2>
    <div class="card"><ul style="margin:0;padding-inline-start:20px;">${rows}</ul></div>
  </section>`;
}

export function generateDiagnosticHtmlReport(data: ReportData): string {
  const now = new Date(data.generatedAt);
  const q = data.reportQuality;

  const body = [
    renderHeader(now, data),
    `<main class="container" dir="rtl">`,
    `<section><div class="card" style="border-right:4px solid var(--amber);">
      <h2 class="section-title">⚠️ הדוח היום לא הופק ברמת האיכות הרגילה</h2>
      <p class="empty">Today's market report could not be produced at normal quality (Report Quality Score: ${q.score}/100 – ${esc(q.band)}). Rather than send a misleading or near-empty newsletter, this is a short diagnostic summary of what we do know right now. The full report resumes automatically once data coverage recovers.</p>
    </div></section>`,
    renderMarketOverview(data.marketOverview),
    renderEarningsCalendar(data.earningsCalendar, data.earningsCalendarStatus),
    renderProviderIssues(data),
    renderLastVerified(data),
    renderDiagnostics(data),
    renderDisclaimer(data.generatedAt),
    `</main>`,
    fingerprintHtmlComment(data),
    provenanceHtmlComment(data),
  ].join("\n");

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Market Report (Diagnostic) – ${esc(fmtDateTime(now))}</title>
  <style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function writeHtmlReport(content: string, outDir = "reports"): string {
  const fullDir = path.resolve(process.cwd(), outDir);
  if (!fs.existsSync(fullDir)) fs.mkdirSync(fullDir, { recursive: true });
  const filePath = path.join(fullDir, "daily-stock-report.html");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}
