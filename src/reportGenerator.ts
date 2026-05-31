import fs from "fs";
import path from "path";
import {
  explainOpportunityHebrew,
  listRisksHebrew,
} from "./explainer";
import { detectMarketMood } from "./marketMood";
import { EnrichedStock, RunStatus } from "./types";

// ---------- formatting helpers ----------

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtChange(pct: number): string {
  return pct >= 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`;
}

function fmtMarketCap(mc?: number): string {
  if (!mc) return "—";
  if (mc >= 1e12) return `$${(mc / 1e12).toFixed(2)}T`;
  if (mc >= 1e9) return `$${(mc / 1e9).toFixed(2)}B`;
  if (mc >= 1e6) return `$${(mc / 1e6).toFixed(0)}M`;
  return `$${mc}`;
}

function fmtDateTime(d: Date): string {
  // ISO-style but readable: 2026-05-31 14:30 UTC
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function sectorOrDash(s: EnrichedStock): string {
  return s.profile?.industry || s.profile?.sector || "—";
}

function newsStatusHebrew(s: EnrichedStock): string {
  if (s.newsSource.source === "live") {
    return `🟢 ${s.news.length} חדשות עדכניות`;
  }
  if (s.newsSource.source === "cached") {
    const age = s.newsSource.ageHours;
    const ageText = age !== undefined ? ` (~${age.toFixed(1)}h)` : "";
    return `🟡 ${s.news.length} חדשות מהמטמון${ageText}`;
  }
  return "🔴 חדשות לא זמינות";
}

// ---------- tables ----------

function moversTable(stocks: EnrichedStock[]): string {
  if (stocks.length === 0) return "_אין נתונים להצגה_";
  const header =
    "| Symbol | Price | Change % | Volume | Score |\n" +
    "| ------ | ----- | -------- | ------ | ----- |";
  const rows = stocks.map((s) => {
    return `| **${s.ticker}** | $${s.price.toFixed(2)} | ${fmtChange(s.changePercent)} | ${fmtNum(s.volume)} | ${s.finalScore.toFixed(1)}/10 |`;
  });
  return [header, ...rows].join("\n");
}

// ---------- opportunity block ----------

function opportunityBlock(s: EnrichedStock): string {
  const name = s.profile?.name ?? s.ticker;
  const sector = sectorOrDash(s);
  const volM = (s.volume / 1_000_000).toFixed(1);
  const cap = fmtMarketCap(s.profile?.marketCap);

  const why = explainOpportunityHebrew(s, s.profile, s.news);
  const risks = listRisksHebrew(s, s.profile, s.news);
  const risksMd = risks.map((r) => `- ${r}`).join("\n");

  return `### ${s.ticker} — ${name}

> ⭐ **Score: ${s.finalScore.toFixed(1)}/10**

- 💰 **Price:** $${s.price.toFixed(2)}
- 📊 **Daily Change:** ${fmtChange(s.changePercent)}
- 🏢 **Sector:** ${sector}${cap !== "—" ? ` · ${cap}` : ""}
- 📈 **Volume:** ${fmtNum(s.volume)} (${volM}M)
- 📰 **News Status:** ${newsStatusHebrew(s)}

#### למה המניה מעניינת?

${why}

#### סיכונים

${risksMd}
`;
}

// ---------- main report ----------

export function generateReport(
  enrichedTop: EnrichedStock[],
  skeletonRest: EnrichedStock[],
  rawCounts: { gainers: number; losers: number; active: number },
  status: RunStatus
): string {
  const now = new Date();
  const combined = [...enrichedTop, ...skeletonRest];

  const topOpportunities = enrichedTop.slice(0, 3);
  const topMovers = combined
    .filter((s) => s.changePercent > 0)
    .sort((a, b) => b.changePercent - a.changePercent)
    .slice(0, 5);
  const negativeMovers = combined
    .filter((s) => s.changePercent < 0)
    .sort((a, b) => a.changePercent - b.changePercent)
    .slice(0, 5);
  const mostActive = combined
    .slice()
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5);

  const mood = detectMarketMood(combined);
  const moodTags =
    mood.tags.length > 0
      ? mood.tags.map((t) => `\`${t}\``).join(" · ")
      : "_ללא תגיות_";

  const opportunitiesSection =
    topOpportunities.length > 0
      ? topOpportunities.map(opportunityBlock).join("\n---\n\n")
      : "_לא נמצאו הזדמנויות מועשרות בריצה הזו._";

  const rateLimitBanner = status.rateLimitHit
    ? "> ⚠️ **הופעלה מגבלת ה-API במהלך הריצה.** חלק מהנתונים נטענו מהמטמון או מסומנים כלא זמינים.\n\n"
    : "";

  return `# 📈 דוח שוק יומי

> **Generated:** ${fmtDateTime(now)}
> **Coverage:** ${rawCounts.gainers + rawCounts.losers + rawCounts.active} מניות מ-Alpha Vantage · ${combined.length} עברו סינון
> **Mood Tags:** ${moodTags}

${rateLimitBanner}---

## 🎯 3 ההזדמנויות המובילות

${opportunitiesSection}

---

## 🚀 המניות החזקות של היום

${moversTable(topMovers)}

---

## 📉 המניות החלשות של היום

${moversTable(negativeMovers)}

---

## 🔥 המניות הפעילות ביותר

${moversTable(mostActive)}

---

## 🧠 סיכום שוק

${mood.summaryHebrew}

${mood.tags.length > 0 ? `**תגיות:** ${moodTags}` : ""}

---

## ⚠️ הערות חשובות

- 🟢 **Live data:** ${status.liveCount} קריאות API טריות
- 🟡 **Cached data:** ${status.cachedCount} ערכים מהמטמון המקומי
- 🔴 **Missing data:** ${status.missingCount} ערכים לא זמינים
- 🧹 **Pre-filter:** סוננו מניות מתחת ל-$5 ומניות OTC / Penny
- 🔬 **Enrichment:** רק 3 ההזדמנויות המובילות מקבלות פרופיל וחדשות מלאים (חיסכון במכסת ה-API החינמית)
${status.rateLimitHit ? "- ⚠️ **API rate limit** הופעל בריצה זו\n" : ""}
---

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
