import fs from "fs";
import path from "path";
import { listRisksHebrew } from "./explainer";
import { watchlistName } from "./universe";
import { EnrichedStock, ReportData, RunStatus, SourceInfo } from "./types";

// ===== helpers =====

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtChange(pct: number): string {
  return pct >= 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`;
}

function changeClass(pct: number): string {
  if (pct > 0) return "up";
  if (pct < 0) return "down";
  return "flat";
}

function fmtMarketCap(mc?: number): string {
  if (!mc) return "—";
  if (mc >= 1e12) return `$${(mc / 1e12).toFixed(2)}T`;
  if (mc >= 1e9) return `$${(mc / 1e9).toFixed(2)}B`;
  if (mc >= 1e6) return `$${(mc / 1e6).toFixed(0)}M`;
  return `$${mc}`;
}

function fmtPrice(p: number): string {
  return p > 0 ? `$${p.toFixed(2)}` : "—";
}

function fmtDateTime(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function scoreTier(score: number): { cls: string; label: string } {
  if (score >= 8) return { cls: "strong", label: "Strong" };
  if (score >= 6) return { cls: "watchlist", label: "Watchlist" };
  return { cls: "cautious", label: "Cautious" };
}

function sourceBadge(s: SourceInfo): string {
  if (s.source === "live") {
    return `<span class="badge live">🟢 Live</span>`;
  }
  if (s.source === "cached") {
    const age = s.ageHours !== undefined ? ` · ~${s.ageHours.toFixed(1)}h` : "";
    return `<span class="badge cached">🟡 Cached${esc(age)}</span>`;
  }
  return `<span class="badge unavailable">🔴 Unavailable</span>`;
}

function sectorOrDash(s: EnrichedStock): string {
  return s.profile?.industry || s.profile?.sector || "—";
}

// ===== sections =====

function renderHeader(now: Date, scanned: number, qualified: number): string {
  return `
  <header class="hero">
    <div class="hero-inner">
      <div class="hero-title">
        <span class="hero-emoji">📈</span>
        <h1>דוח מניות למשקיע לטווח ארוך</h1>
      </div>
      <p class="subtitle">פחות רעיונות, באיכות גבוהה יותר – חברות מבוססות עם יסודות חזקים</p>
      <div class="meta">
        <span class="meta-item"><strong>Generated:</strong> ${esc(fmtDateTime(now))}</span>
        <span class="meta-item"><strong>Coverage:</strong> ${scanned} מניות נסרקו · ${qualified} עברו סינון איכות</span>
      </div>
    </div>
  </header>`;
}

function renderOpportunityCard(s: EnrichedStock): string {
  const tier = scoreTier(s.finalScore);
  const name = s.profile?.name ?? watchlistName(s.ticker) ?? s.ticker;
  const sector = sectorOrDash(s);
  const cap = fmtMarketCap(s.profile?.marketCap);
  const volM = (s.volume / 1_000_000).toFixed(1);
  const why = s.longTermWhyHebrew;
  const risks = listRisksHebrew(s, s.profile, s.news);

  const risksHtml = risks.map((r) => `<li>${esc(r)}</li>`).join("");

  return `
    <article class="opportunity-card card ${tier.cls}">
      <div class="opp-head">
        <div class="opp-id">
          <div>
            <h3 class="ticker">${esc(s.ticker)}</h3>
            <p class="company">${esc(name)}</p>
          </div>
        </div>
        <div class="score-badge ${tier.cls}">
          <span class="score-num">${s.finalScore.toFixed(1)}</span>
          <span class="score-denom">/10</span>
          <span class="score-tier">${tier.label}</span>
        </div>
      </div>

      <div class="metrics">
        <div class="metric">
          <span class="metric-label">💰 מחיר</span>
          <span class="metric-value">${esc(fmtPrice(s.price))}</span>
        </div>
        <div class="metric">
          <span class="metric-label">📊 שינוי יומי</span>
          <span class="metric-value ${changeClass(s.changePercent)}">${esc(s.price > 0 ? fmtChange(s.changePercent) : "—")}</span>
        </div>
        <div class="metric">
          <span class="metric-label">📈 מחזור</span>
          <span class="metric-value">${esc(fmtNum(s.volume))} <span class="metric-sub">(${volM}M)</span></span>
        </div>
        <div class="metric">
          <span class="metric-label">🏢 סקטור</span>
          <span class="metric-value sm">${esc(sector)}${cap !== "—" ? ` · ${esc(cap)}` : ""}</span>
        </div>
      </div>

      <div class="opp-badges">
        <span class="badge-label">📰 חדשות:</span> ${sourceBadge(s.newsSource)}
        <span class="badge-label">📋 פרופיל:</span> ${sourceBadge(s.profileSource)}
      </div>

      <div class="opp-section">
        <h4>למה משקיע ארוך טווח צריך להתעניין במניה</h4>
        <p>${esc(why)}</p>
      </div>

      <div class="opp-section">
        <h4>סיכונים</h4>
        <ul class="risks">${risksHtml}</ul>
      </div>
    </article>`;
}

function renderCategory(
  title: string,
  emoji: string,
  subtitle: string,
  stocks: EnrichedStock[]
): string {
  const inner =
    stocks.length > 0
      ? `<div class="opportunities">${stocks.map(renderOpportunityCard).join("\n")}</div>`
      : `<p class="empty">אין מועמדות מתאימות בקטגוריה זו בריצה הזו.</p>`;
  return `
  <section>
    <h2 class="section-title"><span class="emoji">${emoji}</span> ${esc(title)}</h2>
    <p class="section-subtitle">${esc(subtitle)}</p>
    ${inner}
  </section>`;
}

function renderWatchlistTable(stocks: EnrichedStock[]): string {
  if (stocks.length === 0) {
    return `
  <section>
    <h2 class="section-title"><span class="emoji">⭐</span> Watchlist</h2>
    <p class="empty">אין נתונים להצגה.</p>
  </section>`;
  }

  const rows = stocks
    .map((s) => {
      const tier = scoreTier(s.finalScore);
      const chg = s.price > 0 ? fmtChange(s.changePercent) : "—";
      return `
        <tr>
          <td class="symbol">${esc(s.ticker)}</td>
          <td>${esc(fmtPrice(s.price))}</td>
          <td class="${s.price > 0 ? changeClass(s.changePercent) : "flat"}">${esc(chg)}</td>
          <td><span class="mini-score ${tier.cls}">${s.finalScore.toFixed(1)}</span></td>
        </tr>`;
    })
    .join("");

  return `
  <section>
    <h2 class="section-title"><span class="emoji">⭐</span> Watchlist</h2>
    <p class="section-subtitle">מעקב קבוע אחר מניות איכות מובילות</p>
    <div class="table-wrap card">
      <table class="movers">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Price</th>
            <th>Daily Change</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderDataQuality(status: RunStatus): string {
  return `
  <section>
    <h2 class="section-title"><span class="emoji">⚠️</span> איכות נתונים</h2>
    <div class="quality-grid">
      <div class="quality-stat live-bg">
        <div class="quality-num">${status.liveCount}</div>
        <div class="quality-label">🟢 Live data</div>
      </div>
      <div class="quality-stat cached-bg">
        <div class="quality-num">${status.cachedCount}</div>
        <div class="quality-label">🟡 Cached data</div>
      </div>
      <div class="quality-stat unavailable-bg">
        <div class="quality-num">${status.missingCount}</div>
        <div class="quality-label">🔴 Unavailable</div>
      </div>
    </div>
    ${
      status.rateLimitHit
        ? '<p class="warn">⚠️ הופעלה מגבלת ה-API של Alpha Vantage בריצה זו – חלק מהנתונים נטענו מהמטמון.</p>'
        : ""
    }
  </section>`;
}

function renderDisclaimer(): string {
  return `
  <footer class="disclaimer card">
    <h3>Disclaimer</h3>
    <p><strong>Research only. Not investment advice.</strong></p>
    <p>המידע בדוח זה הוא למטרות מחקר ולמידה בלבד ואינו מהווה ייעוץ השקעות, המלצה לקנייה
    או מכירה של ניירות ערך, או תחליף לייעוץ פיננסי מקצועי. מסחר במניות כרוך בסיכון
    לאובדן ההון – כל החלטה על אחריותך בלבד.</p>
    <p class="generated">Generated by stock-agent · ${esc(new Date().toISOString())}</p>
  </footer>`;
}

// ===== CSS =====

const CSS = `
  :root {
    --navy: #0f172a;
    --navy-2: #1e3a8a;
    --blue: #3b82f6;
    --blue-soft: #dbeafe;
    --bg: #ffffff;
    --bg-soft: #f8fafc;
    --border: #e2e8f0;
    --text: #0f172a;
    --muted: #64748b;
    --green: #10b981;
    --green-soft: #d1fae5;
    --amber: #f59e0b;
    --amber-soft: #fef3c7;
    --red: #ef4444;
    --red-soft: #fee2e2;
    --slate-soft: #f1f5f9;
    --shadow: 0 1px 3px rgba(15,23,42,.04), 0 4px 12px rgba(15,23,42,.06);
    --shadow-lg: 0 4px 6px rgba(15,23,42,.04), 0 10px 30px rgba(15,23,42,.08);
    --radius: 14px;
    --radius-sm: 8px;
  }

  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Heebo",
                 "Rubik", "Assistant", Arial, sans-serif;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .container {
    max-width: 1100px;
    margin: 0 auto;
    padding: 0 20px 80px;
  }

  /* ===== Hero ===== */
  .hero {
    background: linear-gradient(135deg, var(--navy) 0%, var(--navy-2) 60%, var(--blue) 100%);
    color: #fff;
    padding: 48px 0 64px;
    margin-bottom: 32px;
    border-bottom-left-radius: 24px;
    border-bottom-right-radius: 24px;
    box-shadow: var(--shadow-lg);
  }
  .hero-inner {
    max-width: 1100px;
    margin: 0 auto;
    padding: 0 24px;
  }
  .hero-title {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }
  .hero-emoji { font-size: 36px; line-height: 1; }
  .hero h1 {
    margin: 0;
    font-size: clamp(28px, 5vw, 40px);
    font-weight: 800;
    letter-spacing: -0.02em;
  }
  .subtitle {
    margin: 4px 0 20px;
    color: rgba(255,255,255,.85);
    font-size: clamp(14px, 2.5vw, 17px);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 20px;
    font-size: 13px;
    color: rgba(255,255,255,.92);
  }
  .meta-item {
    background: rgba(255,255,255,.12);
    padding: 6px 12px;
    border-radius: 999px;
    backdrop-filter: blur(4px);
  }
  .meta-item strong { color: #fff; font-weight: 600; }

  /* ===== Generic card ===== */
  .card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 22px 22px;
    box-shadow: var(--shadow);
  }
  section { margin-bottom: 28px; }
  .section-title {
    font-size: clamp(18px, 3vw, 22px);
    font-weight: 700;
    color: var(--navy);
    margin: 32px 0 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .emoji { font-size: 1.1em; line-height: 1; }
  .section-subtitle {
    margin: -6px 0 14px;
    color: var(--muted);
    font-size: 14px;
  }
  .empty {
    color: var(--muted);
    background: var(--bg-soft);
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    padding: 16px;
  }

  /* ===== Mood card ===== */
  .mood-card { border-right: 4px solid var(--blue); }
  .card-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 10px;
  }
  .card-head h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--navy);
  }
  .mood-tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .mood-tag {
    background: var(--blue-soft);
    color: var(--navy-2);
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: .02em;
  }
  .mood-tag.muted { background: var(--slate-soft); color: var(--muted); }
  .mood-text {
    margin: 6px 0 0;
    color: var(--text);
    font-size: 15px;
  }

  /* ===== Opportunity cards ===== */
  .opportunities {
    display: grid;
    grid-template-columns: 1fr;
    gap: 18px;
  }
  .opportunity-card {
    border-right: 5px solid var(--blue);
    padding: 24px;
    transition: transform .15s ease, box-shadow .15s ease;
  }
  .opportunity-card:hover {
    transform: translateY(-1px);
    box-shadow: var(--shadow-lg);
  }
  .opportunity-card.strong { border-right-color: var(--green); }
  .opportunity-card.watchlist { border-right-color: var(--amber); }
  .opportunity-card.cautious { border-right-color: var(--muted); }

  .opp-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 18px;
  }
  .opp-id { display: flex; align-items: center; gap: 14px; }
  .rank {
    background: var(--navy);
    color: #fff;
    width: 36px; height: 36px;
    border-radius: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 14px;
  }
  .opp-id h3.ticker {
    margin: 0;
    font-size: 24px;
    font-weight: 800;
    color: var(--navy);
    letter-spacing: -.01em;
  }
  .opp-id p.company {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 14px;
  }

  .score-badge {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 8px 16px;
    border-radius: 12px;
    min-width: 90px;
    text-align: center;
    background: var(--slate-soft);
    color: var(--muted);
  }
  .score-badge.strong { background: var(--green-soft); color: #065f46; }
  .score-badge.watchlist { background: var(--amber-soft); color: #92400e; }
  .score-badge.cautious { background: var(--slate-soft); color: var(--muted); }
  .score-num { font-size: 22px; font-weight: 800; line-height: 1; }
  .score-denom { font-size: 12px; opacity: .8; margin-top: 2px; }
  .score-tier { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; margin-top: 4px; }

  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
    margin-bottom: 16px;
  }
  .metric {
    background: var(--bg-soft);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .metric-label { font-size: 12px; color: var(--muted); }
  .metric-value { font-size: 15px; font-weight: 700; color: var(--navy); }
  .metric-value.sm { font-size: 13px; font-weight: 600; }
  .metric-sub { font-size: 12px; color: var(--muted); font-weight: 500; }
  .metric-value.up { color: var(--green); }
  .metric-value.down { color: var(--red); }

  .opp-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: center;
    margin-bottom: 16px;
    font-size: 13px;
    color: var(--muted);
  }
  .badge-label { font-weight: 600; color: var(--navy); }

  .opp-section { margin-top: 14px; }
  .opp-section h4 {
    margin: 0 0 6px;
    font-size: 14px;
    font-weight: 700;
    color: var(--navy);
    letter-spacing: .01em;
  }
  .opp-section p {
    margin: 0;
    color: var(--text);
    font-size: 14.5px;
  }
  .risks {
    margin: 4px 0 0;
    padding-inline-start: 18px;
    color: var(--text);
    font-size: 14px;
  }
  .risks li { margin-bottom: 4px; }

  /* ===== Badges ===== */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid transparent;
  }
  .badge.live { background: var(--green-soft); color: #065f46; border-color: #a7f3d0; }
  .badge.cached { background: var(--amber-soft); color: #92400e; border-color: #fde68a; }
  .badge.unavailable { background: var(--red-soft); color: #991b1b; border-color: #fecaca; }

  /* ===== Tables ===== */
  .table-wrap {
    padding: 0;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  table.movers {
    width: 100%;
    border-collapse: collapse;
    min-width: 520px;
  }
  table.movers th,
  table.movers td {
    text-align: start;
    padding: 12px 16px;
    font-size: 14px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  table.movers thead th {
    background: var(--bg-soft);
    color: var(--muted);
    font-weight: 600;
    font-size: 12px;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  table.movers tbody tr:last-child td { border-bottom: 0; }
  table.movers tbody tr:hover { background: var(--bg-soft); }
  td.symbol { font-weight: 800; color: var(--navy); }
  td.up { color: var(--green); font-weight: 700; }
  td.down { color: var(--red); font-weight: 700; }
  td.flat { color: var(--muted); }

  .mini-score {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 700;
    background: var(--slate-soft);
    color: var(--muted);
  }
  .mini-score.strong { background: var(--green-soft); color: #065f46; }
  .mini-score.watchlist { background: var(--amber-soft); color: #92400e; }

  /* ===== Data quality ===== */
  .quality-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px;
  }
  .quality-stat {
    border-radius: var(--radius);
    padding: 22px;
    text-align: center;
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
  }
  .live-bg { background: var(--green-soft); border-color: #a7f3d0; }
  .cached-bg { background: var(--amber-soft); border-color: #fde68a; }
  .unavailable-bg { background: var(--red-soft); border-color: #fecaca; }
  .quality-num {
    font-size: 36px;
    font-weight: 800;
    line-height: 1;
    color: var(--navy);
  }
  .quality-label {
    margin-top: 6px;
    color: var(--navy);
    font-weight: 600;
    font-size: 14px;
  }
  .warn {
    margin-top: 14px;
    padding: 12px 16px;
    background: var(--amber-soft);
    color: #92400e;
    border-radius: var(--radius-sm);
    font-weight: 600;
    border: 1px solid #fde68a;
  }

  /* ===== Disclaimer ===== */
  .disclaimer {
    margin-top: 36px;
    background: var(--bg-soft);
    border-color: var(--border);
  }
  .disclaimer h3 {
    margin: 0 0 8px;
    color: var(--navy);
    font-size: 16px;
  }
  .disclaimer p {
    margin: 6px 0;
    color: var(--text);
    font-size: 14px;
  }
  .disclaimer .generated {
    margin-top: 14px;
    color: var(--muted);
    font-size: 12px;
  }

  /* ===== Mobile ===== */
  @media (max-width: 640px) {
    .container { padding: 0 14px 60px; }
    .hero { padding: 36px 0 48px; border-radius: 0 0 18px 18px; }
    .card, .opportunity-card { padding: 18px; }
    .opp-head { flex-direction: column; align-items: stretch; }
    .score-badge { align-self: flex-start; }
    .meta { font-size: 12px; }
  }
`;

// ===== top-level renderer =====

export function generateHtmlReport(data: ReportData): string {
  const now = new Date();
  const { core, growth, speculative, watchlist, status, scanned, qualified } = data;

  const body = [
    renderHeader(now, scanned, qualified),
    `<main class="container">`,
    renderCategory("Core Opportunities", "🏛️", "חברות גדולות ויציבות", core),
    renderCategory("Growth Opportunities", "🌱", "חברות צמיחה בינוניות", growth),
    renderCategory(
      "Speculative Opportunity",
      "🎲",
      "רעיון ספקולטיבי אחד בלבד – לחלק קטן מהתיק",
      speculative
    ),
    renderWatchlistTable(watchlist),
    renderDataQuality(status),
    renderDisclaimer(),
    `</main>`,
  ].join("\n");

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>📈 דוח מניות למשקיע לטווח ארוך – ${esc(fmtDateTime(now))}</title>
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
