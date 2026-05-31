import fs from "fs";
import path from "path";
import { EnrichedStock, NewsItem } from "./types";

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
          .map(
            (n) =>
              `  - [${n.title}](${n.url}) _(${n.source})_`
          )
          .join("\n")
      : "  - _לא נמצאו חדשות רלוונטיות_";

  return `### ${rank}. ${s.ticker} – ${name}

- **בורסה / סקטור:** ${exchange} · ${sector}
- **מחיר:** $${s.price.toFixed(2)} (${fmtChange(s.changePercent)}) · **מחזור:** ${fmtNum(s.volume)} · **שווי שוק:** ${marketCap}
- **ציון כולל:** **${s.finalScore.toFixed(1)}/10**
  (מחיר: ${s.score.priceMove.toFixed(1)} · מחזור: ${s.score.volume.toFixed(1)} · חדשות: ${s.score.newsQuality.toFixed(1)} · איכות חברה: ${s.score.companyQuality.toFixed(1)} · שווי שוק: ${s.score.marketCap.toFixed(1)})
- **למה זזה?** ${s.whyHebrew}
- **חדשות אחרונות:**
${newsList}
`;
}

function flattenKeyNews(stocks: EnrichedStock[], max = 10): Array<{ ticker: string; item: NewsItem }> {
  const all: Array<{ ticker: string; item: NewsItem }> = [];
  for (const s of stocks) {
    for (const n of s.news) {
      if ((n.relevanceScore ?? 0) >= 0.3) {
        all.push({ ticker: s.ticker, item: n });
      }
    }
  }
  all.sort(
    (a, b) =>
      (b.item.relevanceScore ?? 0) - (a.item.relevanceScore ?? 0)
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

  const avgScore =
    all.length > 0
      ? (all.reduce((a, b) => a + b.finalScore, 0) / all.length).toFixed(1)
      : "—";

  const bestMove =
    all.length > 0
      ? all
          .slice()
          .sort((a, b) => b.changePercent - a.changePercent)[0]
      : null;
  const worstMove =
    all.length > 0
      ? all
          .slice()
          .sort((a, b) => a.changePercent - b.changePercent)[0]
      : null;

  return `- **מקור גולמי מ-Alpha Vantage:** ${rawCounts.gainers} עולים · ${rawCounts.losers} יורדים · ${rawCounts.active} פעילים
- **לאחר סינון פני/OTC ומחיר מתחת ל-$5:** ${all.length} מניות נכנסו לדירוג
- **חברות בענפי טכנולוגיה / AI / סייבר / סמיקונדקטור:** ${techCount}
- **ציון ממוצע (1–10):** ${avgScore}
- **תנועה חיובית בולטת:** ${bestMove ? `${bestMove.ticker} ${fmtChange(bestMove.changePercent)}` : "—"}
- **תנועה שלילית בולטת:** ${worstMove ? `${worstMove.ticker} ${fmtChange(worstMove.changePercent)}` : "—"}`;
}

export function generateReport(
  all: EnrichedStock[],
  rawCounts: { gainers: number; losers: number; active: number }
): string {
  const today = new Date().toISOString().slice(0, 10);

  const topOpportunities = all.slice(0, 3);
  const topMovers = all
    .filter((s) => s.changePercent > 0)
    .sort((a, b) => b.changePercent - a.changePercent)
    .slice(0, 5);
  const negativeMovers = all
    .filter((s) => s.changePercent < 0)
    .sort((a, b) => a.changePercent - b.changePercent)
    .slice(0, 5);
  const mostActive = all
    .slice()
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5);

  const keyNews = flattenKeyNews(all, 10);
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
      : "_לא נמצאו חדשות בולטות לדוח זה._";

  const opportunitiesSection =
    topOpportunities.length > 0
      ? topOpportunities.map((s, i) => opportunityBlock(s, i + 1)).join("\n")
      : "_לא זוהו הזדמנויות איכותיות לפי הסינון היום._";

  return `# דוח מחקר מניות יומי – ${today}

> דוח אוטומטי שנוצר על ידי **stock-agent** בהתבסס על נתוני Alpha Vantage (תוכנית חינמית).
> מותאם לסגנון משקיע מקצועי: סינון מניות פני / OTC, פוקוס על Nasdaq וחברות צמיחה בטכנולוגיה / AI / סייבר / סמיקונדקטור.

---

## 1. סקירת שוק (Market Summary)

${buildMarketSummary(all, rawCounts)}

---

## 2. הזדמנויות מובילות (Top 3 Opportunities)

${opportunitiesSection}

---

## 3. עולים בולטים (Top Movers)

${moversTable(topMovers)}

---

## 4. יורדים בולטים (Negative Movers)

${moversTable(negativeMovers)}

---

## 5. הכי פעילים (Most Active Stocks)

${moversTable(mostActive)}

---

## 6. חדשות מרכזיות (Key News)

${keyNewsList}

---

## 7. סיכונים (Risks)

- **איכות נתונים:** Alpha Vantage בתוכנית חינמית מוגבל ב-5 קריאות/דקה ו-25 קריאות/יום – חלק מהמניות עשויות לחזור ללא פרופיל מלא או ללא חדשות.
- **ציון אלגוריתמי בלבד:** הציון 1–10 הוא נוסחה היוריסטית (תנועה, מחזור, חדשות, איכות חברה, שווי שוק). הוא **אינו** מבטא הסתברות לרווח.
- **רעש שוק:** תנועות חזקות ביום בודד יכולות להיות תוצאה של חדשה נקודתית, סקוויז, או מניפולציה ולא של שינוי פונדמנטלי.
- **סיכון מטבע וזירה:** המחירים בדולר, ייתכן חשיפה לשערי חליפין ולשעות מסחר אמריקאיות בלבד.
- **חדשות לא תמיד עדכניות:** ה-NEWS_SENTIMENT API מחזיר חדשות עד 24–48 שעות אחורה; ייתכן שאירוע מהותי טרי עדיין לא מתועד.

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
  if (!fs.existsSync(fullDir)) {
    fs.mkdirSync(fullDir, { recursive: true });
  }
  const filePath = path.join(fullDir, "daily-stock-report.md");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}
