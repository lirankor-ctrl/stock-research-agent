import fs from "fs";
import path from "path";
import { EnrichedStock, NewsItem, RunStatus, SourceInfo } from "./types";

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

// Hebrew badge for any data source
function sourceBadgeHe(s: SourceInfo): string {
  if (s.source === "live") return "🟢 נתונים חיים (live)";
  if (s.source === "cached") {
    const age =
      s.ageHours !== undefined ? ` – נשמר לפני ~${s.ageHours.toFixed(1)} שעות` : "";
    return `🟡 נתונים מהמטמון (cached)${age}`;
  }
  return "🔴 לא זמין (unavailable)";
}

function shortBadge(s: SourceInfo): string {
  if (s.source === "live") return "🟢 live";
  if (s.source === "cached")
    return `🟡 cached${s.ageHours !== undefined ? ` (~${s.ageHours.toFixed(1)}h)` : ""}`;
  return "🔴 unavailable";
}

// ---------- tables ----------

function moversTable(stocks: EnrichedStock[]): string {
  if (stocks.length === 0) return "_אין נתונים_";
  const header =
    "| # | טיקר | חברה | מחיר | שינוי % | מחזור | שווי שוק | ציון |\n" +
    "|---|------|------|------|---------|-------|----------|------|";
  const rows = stocks.map((s, i) => {
    const name = s.profile?.name ?? "—";
    return `| ${i + 1} | **${s.ticker}** | ${name} | $${s.price.toFixed(2)} | ${fmtChange(s.changePercent)} | ${fmtNum(s.volume)} | ${fmtMarketCap(s.profile?.marketCap)} | **${s.finalScore.toFixed(1)}/10** |`;
  });
  return [header, ...rows].join("\n");
}

function opportunityBlock(s: EnrichedStock, rank: number): string {
  const name = s.profile?.name ?? s.ticker;
  const sector = s.profile?.industry || s.profile?.sector || "—";
  const exchange = s.profile?.exchange ?? "—";
  const marketCap = fmtMarketCap(s.profile?.marketCap);

  const newsList =
    s.news.length > 0
      ? s.news
          .slice(0, 3)
          .map((n) => `  - [${n.title}](${n.url}) _(${n.source})_`)
          .join("\n")
      : "  - _לא נמצאו חדשות רלוונטיות_";

  return `### ${rank}. ${s.ticker} – ${name}

- **מקור פרופיל:** ${sourceBadgeHe(s.profileSource)} · **מקור חדשות:** ${sourceBadgeHe(s.newsSource)}
- **בורסה / סקטור:** ${exchange} · ${sector}
- **מחיר:** $${s.price.toFixed(2)} (${fmtChange(s.changePercent)}) · **מחזור:** ${fmtNum(s.volume)} · **שווי שוק:** ${marketCap}
- **ציון כולל:** **${s.finalScore.toFixed(1)}/10**
  (מחיר: ${s.score.priceMove.toFixed(1)} · מחזור: ${s.score.volume.toFixed(1)} · חדשות: ${s.score.newsQuality.toFixed(1)} · איכות חברה: ${s.score.companyQuality.toFixed(1)} · שווי שוק: ${s.score.marketCap.toFixed(1)})
- **למה זזה?** ${s.whyHebrew}
- **חדשות אחרונות:**
${newsList}
`;
}

function flattenKeyNews(
  stocks: EnrichedStock[],
  max = 10
): Array<{ ticker: string; item: NewsItem }> {
  const all: Array<{ ticker: string; item: NewsItem }> = [];
  for (const s of stocks) {
    for (const n of s.news) {
      if ((n.relevanceScore ?? 0) >= 0.3) all.push({ ticker: s.ticker, item: n });
    }
  }
  all.sort(
    (a, b) => (b.item.relevanceScore ?? 0) - (a.item.relevanceScore ?? 0)
  );
  return all.slice(0, max);
}

function buildMarketSummary(
  all: EnrichedStock[],
  rawCounts: { gainers: number; losers: number; active: number }
): string {
  const techCount = all.filter((s) => {
    const sec = (s.profile?.sector ?? "").toLowerCase();
    const ind = (s.profile?.industry ?? "").toLowerCase();
    return (
      sec.includes("tech") ||
      ind.includes("software") ||
      ind.includes("semi") ||
      ind.includes("cyber") ||
      ind.includes("ai")
    );
  }).length;

  const bestMove =
    all.length > 0
      ? all.slice().sort((a, b) => b.changePercent - a.changePercent)[0]
      : null;
  const worstMove =
    all.length > 0
      ? all.slice().sort((a, b) => a.changePercent - b.changePercent)[0]
      : null;

  return `- **מקור גולמי מ-Alpha Vantage:** ${rawCounts.gainers} עולים · ${rawCounts.losers} יורדים · ${rawCounts.active} פעילים
- **לאחר סינון פני/OTC ומחיר מתחת ל-$5:** ${all.length} מניות בדירוג
- **חברות בענפי טכנולוגיה / AI / סייבר / סמיקונדקטור (מבין המועשרות):** ${techCount}
- **תנועה חיובית בולטת:** ${bestMove ? `${bestMove.ticker} ${fmtChange(bestMove.changePercent)}` : "—"}
- **תנועה שלילית בולטת:** ${worstMove ? `${worstMove.ticker} ${fmtChange(worstMove.changePercent)}` : "—"}`;
}

// ---------- main report ----------

export function generateReport(
  enrichedTop: EnrichedStock[],
  skeletonRest: EnrichedStock[],
  rawCounts: { gainers: number; losers: number; active: number },
  status: RunStatus
): string {
  const today = new Date().toISOString().slice(0, 10);

  // For top-movers / negative / most-active we use the *combined* list,
  // but those rows show minimal info because we only enriched the top 3.
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
  const mostActive = combined.slice().sort((a, b) => b.volume - a.volume).slice(0, 5);

  const keyNews = flattenKeyNews(enrichedTop, 10);
  const keyNewsList =
    keyNews.length > 0
      ? keyNews
          .map(
            (n) =>
              `- **${n.ticker}** – [${n.item.title}](${n.item.url}) _(${n.item.source}${
                n.item.sentimentLabel ? `, sentiment: ${n.item.sentimentLabel}` : ""
              })_`
          )
          .join("\n")
      : "_לא נמצאו חדשות בולטות בריצה הזו (ייתכן בשל מטמון חסר או הגעה למגבלת ה-API)._";

  const opportunitiesSection =
    topOpportunities.length > 0
      ? topOpportunities.map((s, i) => opportunityBlock(s, i + 1)).join("\n")
      : "_אין הזדמנויות מועשרות בריצה הזו._";

  const notesBlock =
    status.notes.length > 0
      ? "\n**הערות מהריצה:**\n" +
        status.notes
          .slice(-8)
          .map((n) => `- ${n}`)
          .join("\n")
      : "";

  const rateLimitBanner = status.rateLimitHit
    ? "> ⚠️ **הופעלה מגבלת API במהלך הריצה.** חלק מהנתונים נטענו מהמטמון או סומנו כלא זמינים.\n\n"
    : "";

  return `# דוח מחקר מניות יומי – ${today}

> דוח אוטומטי שנוצר על ידי **stock-agent** בהתבסס על נתוני Alpha Vantage (תוכנית חינמית).
> פוקוס: חברות צמיחה ב-Nasdaq / טכנולוגיה / AI / סייבר / סמיקונדקטור.

${rateLimitBanner}## מצב מקורות הנתונים

- **רשימת מניות פעילות (Top Gainers/Losers/Active):** ${sourceBadgeHe(status.movers)}
- **העשרה (פרופיל + חדשות) ל-Top 3:** ${sourceBadgeHe(status.enriched)}
- **שאר הרשימה (Top Movers / Negative / Most Active):** 🔴 ללא העשרה – ציון מבוסס מחיר ומחזור בלבד (חיסכון במגבלת API)
${notesBlock}

---

## 1. סקירת שוק (Market Summary) – ${shortBadge(status.movers)}

${buildMarketSummary(combined, rawCounts)}

---

## 2. הזדמנויות מובילות (Top 3 Opportunities) – ${shortBadge(status.enriched)}

${opportunitiesSection}

---

## 3. עולים בולטים (Top Movers) – ${shortBadge(status.movers)}

${moversTable(topMovers)}

---

## 4. יורדים בולטים (Negative Movers) – ${shortBadge(status.movers)}

${moversTable(negativeMovers)}

---

## 5. הכי פעילים (Most Active Stocks) – ${shortBadge(status.movers)}

${moversTable(mostActive)}

---

## 6. חדשות מרכזיות (Key News) – ${shortBadge(status.enriched)}

${keyNewsList}

---

## 7. סיכונים (Risks)

- **מגבלת API חינמית:** Alpha Vantage Free Tier = 25 קריאות/יום. הסוכן מטמיין נתוני שוק ל-12 שעות ונתוני פרופיל/חדשות ל-24 שעות. אם המטמון חסר ה-API חסום, חלקים בדוח יסומנו "לא זמין".
- **רק 3 מניות מועשרות:** כדי לחסוך במכסה, רק 3 ההזדמנויות המובילות מקבלות פרופיל וחדשות מלאים. שאר המניות בדוח – ציון מבוסס מחיר ומחזור בלבד.
- **ציון אלגוריתמי בלבד:** הציון 1–10 הוא נוסחה היוריסטית – אינו הסתברות לרווח.
- **רעש שוק:** תנועות חזקות יומיות יכולות להיות תוצאה של סקוויז, חדשה נקודתית או מניפולציה.
- **חדשות עשויות להיות מאוחרות:** ה-NEWS_SENTIMENT API מכסה את 24–48 השעות האחרונות; אירועים טריים עלולים לא להופיע.

---

## 8. הצהרת אחריות (Disclaimer)

המידע בדוח זה הוא **למטרות מחקר ולמידה בלבד**.
**אין לראות בתוכן ייעוץ השקעות, המלצה לקנייה או מכירה של ניירות ערך, ואין בו תחליף לייעוץ פיננסי מקצועי.**
מסחר במניות כרוך בסיכון לאובדן ההון. כל החלטה – על אחריותך בלבד.

_נוצר אוטומטית ב-${new Date().toISOString()}_
`;
}

export function writeReport(content: string, outDir = "reports"): string {
  const fullDir = path.resolve(process.cwd(), outDir);
  if (!fs.existsSync(fullDir)) fs.mkdirSync(fullDir, { recursive: true });
  const filePath = path.join(fullDir, "daily-stock-report.md");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}
