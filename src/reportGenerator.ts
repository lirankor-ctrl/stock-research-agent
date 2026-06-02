import fs from "fs";
import path from "path";
import { listRisksHebrew } from "./explainer";
import { watchlistName } from "./universe";
import { EnrichedStock, FearGreed, ReportData } from "./types";

function displayName(s: EnrichedStock): string {
  return s.profile?.name ?? watchlistName(s.ticker) ?? s.ticker;
}

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

// ---------- opportunity block ----------

function opportunityBlock(s: EnrichedStock): string {
  const name = displayName(s);
  const sector = sectorOrDash(s);
  const volM = (s.volume / 1_000_000).toFixed(1);
  const cap = fmtMarketCap(s.profile?.marketCap);

  const risks = listRisksHebrew(s, s.profile, s.news);
  const risksMd = risks.map((r) => `- ${r}`).join("\n");

  return `### ${s.ticker} — ${name}

> ⭐ **Score: ${s.finalScore.toFixed(1)}/10**

- 💰 **Price:** ${fmtPrice(s.price)}
- 📊 **Daily Change:** ${fmtChange(s.changePercent)}
- 🏢 **Sector:** ${sector}${cap !== "—" ? ` · ${cap}` : ""}
- 📈 **Volume:** ${fmtNum(s.volume)} (${volM}M)
- 📰 **News Status:** ${newsStatusHebrew(s)}

#### למה משקיע ארוך טווח צריך להתעניין במניה

${s.longTermWhyHebrew}

#### סיכונים

${risksMd}
`;
}

function categorySection(
  title: string,
  emoji: string,
  subtitle: string,
  stocks: EnrichedStock[]
): string {
  const body =
    stocks.length > 0
      ? stocks.map(opportunityBlock).join("\n---\n\n")
      : "_אין מועמדות מתאימות בקטגוריה זו בריצה הזו._";
  return `## ${emoji} ${title}

_${subtitle}_

${body}`;
}

// ---------- watchlist table ----------

function watchlistTable(stocks: EnrichedStock[]): string {
  if (stocks.length === 0) return "_אין נתונים להצגה_";
  const header =
    "| Symbol | Price | Daily Change | Score |\n" +
    "| ------ | ----- | ------------ | ----- |";
  const rows = stocks.map(
    (s) =>
      `| **${s.ticker}** | ${fmtPrice(s.price)} | ${s.price > 0 ? fmtChange(s.changePercent) : "—"} | ${s.finalScore.toFixed(1)}/10 |`
  );
  return [header, ...rows].join("\n");
}

// ---------- main report ----------

export function generateReport(data: ReportData): string {
  const now = new Date();
  const { core, growth, speculative, watchlist, status, scanned, qualified, fearGreed } = data;

  const rateLimitBanner = status.rateLimitHit
    ? "> ⚠️ **הופעלה מגבלת ה-API במהלך הריצה.** חלק מהנתונים נטענו מהמטמון או מסומנים כלא זמינים.\n\n"
    : "";

  return `# 📈 דוח מניות למשקיע לטווח ארוך

> **Generated:** ${fmtDateTime(now)}
> **Coverage:** ${scanned} מניות נסרקו · ${qualified} עברו את סינון האיכות
> **גישה:** פחות רעיונות, באיכות גבוהה יותר – חברות מבוססות עם יסודות חזקים.

${rateLimitBanner}---

${marketSentimentSection(fearGreed)}

---

${categorySection("Core Opportunities", "🏛️", "חברות גדולות ויציבות", core)}

---

${categorySection("Growth Opportunities", "🌱", "חברות צמיחה בינוניות", growth)}

---

${categorySection("Speculative Opportunity", "🎲", "רעיון ספקולטיבי אחד בלבד – לחלק קטן מהתיק", speculative)}

---

## ⭐ Watchlist

_מעקב קבוע אחר מניות איכות מובילות:_

${watchlistTable(watchlist)}

---

## ⚠️ הערות חשובות

- 🟢 **Live data:** ${status.liveCount} קריאות API טריות
- 🟡 **Cached data:** ${status.cachedCount} ערכים מהמטמון המקומי
- 🔴 **Missing data:** ${status.missingCount} ערכים לא זמינים
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
