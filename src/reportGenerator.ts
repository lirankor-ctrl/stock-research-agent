import fs from "fs";
import path from "path";
import { listRisksHebrew } from "./explainer";
import { rsiInterpretation } from "./technicals";
import { watchlistName } from "./universe";
import {
  BandProximity,
  DataQualityLabel,
  EnrichedStock,
  ExpansionItem,
  FearGreed,
  MarketStory,
  OpportunityTier,
  ReportData,
  TechnicalAlert,
  TechnicalAlerts,
} from "./types";

function displayName(s: EnrichedStock): string {
  return s.profile?.name ?? watchlistName(s.ticker) ?? s.ticker;
}

// ---------- data-quality helpers ----------

const DQ_EMOJI: Record<DataQualityLabel, string> = {
  High: "🟢",
  Medium: "🟡",
  Low: "🟠",
  Excluded: "🔴",
};

function dqBadge(s: EnrichedStock): string {
  const dq = s.dataQuality;
  if (!dq) return "—";
  return `${DQ_EMOJI[dq.label]} ${dq.label} (${dq.score}/100)`;
}

const TIER_HEBREW: Record<OpportunityTier, string> = {
  core: "🏛️ Core · ליבה",
  growth: "🌱 Growth · צמיחה",
  speculative: "🎲 Speculative · ספקולטיבי",
  none: "—",
};

// ---------- formatting helpers ----------

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtChange(pct: number): string {
  return pct >= 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`;
}

function fmtPrice(p: number): string {
  return p > 0 ? `$${p.toFixed(2)}` : "—";
}

function fmtMarketCap(mc?: number): string {
  if (!mc) return "—";
  if (mc >= 1e12) return `$${(mc / 1e12).toFixed(2)}T`;
  if (mc >= 1e9) return `$${(mc / 1e9).toFixed(2)}B`;
  if (mc >= 1e6) return `$${(mc / 1e6).toFixed(0)}M`;
  return `$${mc}`;
}

function fmtDateTime(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function sectorOrDash(s: EnrichedStock): string {
  return s.profile?.industry || s.profile?.sector || "—";
}

function newsStatusHebrew(s: EnrichedStock): string {
  if (s.newsSource.source === "live") return `🟢 ${s.news.length} חדשות עדכניות`;
  if (s.newsSource.source === "cached") {
    const age = s.newsSource.ageHours;
    const ageText = age !== undefined ? ` (~${age.toFixed(1)}h)` : "";
    return `🟡 ${s.news.length} חדשות מהמטמון${ageText}`;
  }
  return "🔴 חדשות לא זמינות";
}

// ---------- market story of the day ----------

function marketStorySection(story: MarketStory | null): string {
  if (!story) {
    return `## 📰 Market Story of the Day

_לא נמצאה ידיעה חדשותית מהותית היום._`;
  }

  const moveLine =
    story.priceMove && story.priceMove.price > 0
      ? `\n- 📊 **תנועת מחיר:** ${fmtPrice(story.priceMove.price)} (${fmtChange(story.priceMove.changePercent)})`
      : "";
  // Image: only show a logo URL if one is safely available; otherwise the ticker
  // itself stands in as the visual anchor (no copyrighted images are embedded).
  const logoLine = story.logoUrl ? `\n- 🖼️ **לוגו:** ${story.logoUrl}` : "";
  const original = story.originalSummary
    ? `\n\n> _תקציר המקור (באנגלית):_ ${story.originalSummary}`
    : "";

  return `## 📰 Market Story of the Day

### \`${story.ticker}\` — ${story.companyName}

**${story.headline}**

- 🗞️ **מקור:** ${story.source}
- 🕒 **תאריך:** ${story.publishedDisplay}${moveLine}${logoLine}

${story.summaryHebrew}

**למה זה חשוב למשקיע לטווח ארוך:** ${story.whyMattersHebrew}

🔗 [קריאת הידיעה המלאה במקור](${story.url})${original}`;
}

// ---------- market sentiment (Fear & Greed) ----------

function marketSentimentSection(fg: FearGreed | null): string {
  if (!fg) {
    return `## 🌎 Market Sentiment

_Fear & Greed Index unavailable_`;
  }
  return `## 🌎 Market Sentiment

- **Fear & Greed Index:** ${fg.score}
- **Classification:** ${fg.classification}

${fg.hebrew}`;
}

// ---------- technical alerts (Bollinger Bands + RSI) ----------

function alertBlock(a: TechnicalAlert, kind: "above" | "below"): string {
  const rsi = rsiInterpretation(a.rsi14);
  const bandLabel = kind === "above" ? "Upper Band" : "Lower Band";
  const distLabel = kind === "above" ? "Above Band" : "Below Band";
  return `**${a.ticker}** — ${a.name}
- Price: ${fmtPrice(a.price)}
- ${bandLabel}: ${fmtPrice(a.band)}
- ${distLabel}: +${a.pctFromBand.toFixed(1)}%
- RSI: ${Math.round(a.rsi14)} (${rsi.label} · ${rsi.hebrew})`;
}

function proximityTable(items: BandProximity[], distHeader: string): string {
  if (items.length === 0) return "_אין נתונים זמינים._";
  const header =
    `| Symbol | Price | ${distHeader} | RSI |\n` +
    "| ------ | ----- | ------------- | --- |";
  const rows = items.map((p) => {
    const rsi = rsiInterpretation(p.rsi14);
    return `| **${p.ticker}** | ${fmtPrice(p.price)} | ${p.distancePct.toFixed(1)}% | ${Math.round(p.rsi14)} (${rsi.label}) |`;
  });
  return [header, ...rows].join("\n");
}

function expansionTable(items: ExpansionItem[]): string {
  if (items.length === 0) return "_אין נתוני התרחבות זמינים._";
  const header =
    "| Symbol | Band Width Δ | RSI |\n" +
    "| ------ | ------------ | --- |";
  const rows = items.map((e) => {
    const rsi = rsiInterpretation(e.rsi14);
    const sign = e.widthChangePct >= 0 ? "+" : "";
    return `| **${e.ticker}** | ${sign}${e.widthChangePct.toFixed(1)}% | ${Math.round(e.rsi14)} (${rsi.label}) |`;
  });
  return [header, ...rows].join("\n");
}

function technicalAlertsSection(alerts: TechnicalAlerts): string {
  const { aboveUpper, belowLower, closestToUpper, closestToLower, expansion } = alerts;

  // No daily data at all (rate-limited, no cache) – show a clear notice.
  if (alerts.dataUnavailable) {
    return `## 📊 Technical Alerts

> ⚠️ **Technical data unavailable today due to API rate limit.**
>
> הנתונים הטכניים (Bollinger Bands / RSI) אינם זמינים היום עקב מגבלת ה-API ואין נתונים שמורים במטמון. הסעיף יתעדכן בריצה הבאה. אין לכך השפעה על ציון איכות הנתונים של המניות.`;
  }

  // Above the upper band: real breaches if any, otherwise the closest names.
  const aboveBlock =
    aboveUpper.length > 0
      ? `### 🔴 Above Upper Bollinger Band

${aboveUpper.map((a) => alertBlock(a, "above")).join("\n\n")}`
      : `### 🔥 Closest To Upper Bollinger Band

_אף מניה לא פרצה את הרצועה העליונה. אלו הקרובות ביותר לפריצה (קניית-יתר אפשרית) – מרחק קטן יותר = קרובה יותר:_

${proximityTable(closestToUpper, "Distance To Upper")}`;

  // Below the lower band: real breaches if any, otherwise the closest names.
  const belowBlock =
    belowLower.length > 0
      ? `### 🟢 Below Lower Bollinger Band

${belowLower.map((a) => alertBlock(a, "below")).join("\n\n")}`
      : `### 🟢 Closest To Lower Bollinger Band

_אף מניה לא שברה את הרצועה התחתונה. אלו הקרובות ביותר לשבירה (מכירת-יתר אפשרית) – מרחק קטן יותר = קרובה יותר:_

${proximityTable(closestToLower, "Distance To Lower")}`;

  return `## 📊 Technical Alerts

רצועות בולינג'ר מסייעות לזהות מצבי קיצון. מניות מעל הרצועה העליונה עשויות להיות במצב קניית יתר, ומניות מתחת לרצועה התחתונה עשויות להיות במצב מכירת יתר.

**פירוש RSI:** RSI > 70 = Overbought · 60–70 = Strong Momentum · 40–60 = Neutral · 30–40 = Weak · < 30 = Oversold

${aboveBlock}

${belowBlock}

### 📈 Bollinger Expansion Watch

_מניות עם ההתרחבות הגדולה ביותר ברוחב רצועות בולינג'ר לאחרונה. התרחבות מעידה על עלייה בתנודתיות – לעיתים תחילתו של מהלך חזק:_

${expansionTable(expansion)}`;
}

// ---------- opportunity block ----------

function opportunityBlock(s: EnrichedStock): string {
  const name = displayName(s);
  const sector = sectorOrDash(s);
  const volM = (s.volume / 1_000_000).toFixed(1);
  const cap = fmtMarketCap(s.profile?.marketCap);

  const risks = listRisksHebrew(s, s.profile, s.news);
  const risksMd = risks.map((r) => `- ${r}`).join("\n");

  const dq = s.dataQuality;
  const missingMd =
    dq && dq.missing.length > 0 ? dq.missing.join(", ") : "אין – כל הנתונים שנאספו מלאים";
  const rateLimitedMd =
    dq && dq.rateLimited.length > 0
      ? `\n\n#### סטטוס API (לא נספר באיכות)\n\n${dq.rateLimited.join(", ")} — Missing (Rate Limit)`
      : "";
  const reliability = dq?.reliabilityHebrew ?? "—";

  return `### ${s.ticker} — ${name}

> ⭐ **Score: ${s.finalScore.toFixed(1)}/10** · 🏷️ **${TIER_HEBREW[s.tier]}** · 🧪 **איכות נתונים: ${dqBadge(s)}**

- 💰 **Price:** ${fmtPrice(s.price)}
- 📊 **Daily Change:** ${fmtChange(s.changePercent)}
- 🏢 **Sector:** ${sector}${cap !== "—" ? ` · ${cap}` : ""}
- 📈 **Volume:** ${fmtNum(s.volume)} (${volM}M)
- 📰 **News Status:** ${newsStatusHebrew(s)}

#### למה המניה מופיעה כאן

${s.longTermWhyHebrew}

#### מה חסר בנתונים

${missingMd}${rateLimitedMd}

#### עד כמה האות אמין

${reliability}

#### סיכונים

${risksMd}
`;
}

function topOpportunitiesSection(stocks: EnrichedStock[]): string {
  const body =
    stocks.length > 0
      ? stocks.map(opportunityBlock).join("\n---\n\n")
      : "_אין הזדמנויות שעברו את סף איכות הנתונים בריצה הזו._";
  return `## 🎯 Top Opportunities (${stocks.length}/3)

_עד 3 הזדמנויות מובילות בלבד – אחרי דירוג וסינון לפי איכות נתונים (רק High/Medium)._

${body}`;
}

// ---------- watchlist table ----------

function watchlistTable(stocks: EnrichedStock[]): string {
  if (stocks.length === 0) return "_אין נתונים להצגה_";
  const header =
    "| Symbol | Price | Daily Change | Score | Data Quality |\n" +
    "| ------ | ----- | ------------ | ----- | ------------ |";
  const rows = stocks.map(
    (s) =>
      `| **${s.ticker}** | ${fmtPrice(s.price)} | ${s.price > 0 ? fmtChange(s.changePercent) : "—"} | ${s.finalScore.toFixed(1)}/10 | ${dqBadge(s)} |`
  );
  return [header, ...rows].join("\n");
}

function watchlistHighlightsSection(stocks: EnrichedStock[]): string {
  if (stocks.length === 0) {
    return `## ⭐ Watchlist Highlights (0/5)

_אין מניות מעקב שעברו את סף איכות הנתונים בריצה הזו._`;
  }
  const header =
    "| Symbol | Name | Price | Score | Data Quality |\n" +
    "| ------ | ---- | ----- | ----- | ------------ |";
  const rows = stocks.map(
    (s) =>
      `| **${s.ticker}** | ${displayName(s)} | ${fmtPrice(s.price)} | ${s.finalScore.toFixed(1)}/10 | ${dqBadge(s)} |`
  );
  return `## ⭐ Watchlist Highlights (${stocks.length}/5)

_עד 5 מניות המעקב האיכותיות ביותר בריצה הזו (לפי ניקוד ואיכות נתונים)._

${[header, ...rows].join("\n")}`;
}

// ---------- main report ----------

export function generateReport(data: ReportData): string {
  const now = new Date();
  const {
    marketStory,
    topOpportunities,
    watchlistHighlights,
    watchlist,
    technicalAlerts,
    status,
    scanned,
    qualified,
    fearGreed,
  } = data;

  const rateLimitBanner = status.rateLimitHit
    ? "> ⚠️ **הופעלה מגבלת ה-API במהלך הריצה.** חלק מהנתונים נטענו מהמטמון או מסומנים כלא זמינים.\n\n"
    : "";

  return `# 📈 דוח מניות למשקיע לטווח ארוך

> **Generated:** ${fmtDateTime(now)}
> **Coverage:** ${scanned} מניות נסרקו · ${qualified} עברו את סינון האיכות
> **גישה:** פחות רעיונות, באיכות גבוהה יותר – חברות מבוססות עם יסודות חזקים.

${rateLimitBanner}---

${marketStorySection(marketStory)}

---

${marketSentimentSection(fearGreed)}

---

${technicalAlertsSection(technicalAlerts)}

---

${topOpportunitiesSection(topOpportunities)}

---

${watchlistHighlightsSection(watchlistHighlights)}

---

## ⭐ Watchlist (all)

_מעקב קבוע אחר כל מניות האיכות ברשימה (כולל איכות נתונים לכל אחת):_

${watchlistTable(watchlist)}

---

## ⚠️ הערות חשובות

- 🟢 **Live data:** ${status.liveCount} קריאות API טריות
- 🟡 **Cached data:** ${status.cachedCount} ערכים מהמטמון המקומי
- 🔴 **Missing data:** ${status.missingCount} ערכים לא זמינים
- 🧪 **איכות נתונים (Data Quality):** מודד את שלמות הנתונים שנאספו בפועל – לא זמינות ה-API. ציון 0–100 לפי מחיר (30), פרופיל (20), שווי שוק (20), מחזור (15), חדשות (10) וטכני (5). נתון שלא נשלף עקב מגבלת API מסומן "Missing (Rate Limit)" ו**אינו** מפחית את הציון (מוסר מהחישוב). רק נתון שחסר באמת מפחית את הציון. תוויות: 🟢 High ≥80 · 🟡 Medium ≥60 · 🟠 Low ≥40 · 🔴 Excluded (חוסר נתונים קריטי אמיתי בלבד).
- 🧹 **סינון:** מתחת ל-$10, שווי שוק מתחת ל-$2B, OTC, וורנטים, יחידות ושרידי SPAC הוסרו. תנועה יומית מעל 40% מותרת רק לחברות מעל $10B.
- 🎯 **ניקוד:** 40% איכות החברה · 20% מומנטום · 20% מחזור · 20% איכות חדשות (עם קנס על הפסדים, מיקרו-קאפ ותנודתיות קיצונית).
${status.rateLimitHit ? "- ⚠️ **API rate limit** הופעל בריצה זו\n" : ""}---

## Disclaimer

**Research only. Not investment advice.**
המידע בדוח זה הוא למטרות מחקר ולמידה בלבד ואינו מהווה ייעוץ השקעות, המלצה לקנייה או מכירה של ניירות ערך,
או תחליף לייעוץ פיננסי מקצועי. מסחר במניות כרוך בסיכון לאובדן ההון – כל החלטה על אחריותך בלבד.

_Generated by stock-agent · ${now.toISOString()}_
`;
}

export function writeReport(content: string, outDir = "reports"): string {
  const fullDir = path.resolve(process.cwd(), outDir);
  if (!fs.existsSync(fullDir)) fs.mkdirSync(fullDir, { recursive: true });
  const filePath = path.join(fullDir, "daily-stock-report.md");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}
