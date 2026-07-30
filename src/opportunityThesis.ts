import { explainWhyHebrew, listRisksHebrew } from "./explainer";
import { isPromotionalOrLegalNews, pickRelevantNews } from "./newsFilter";
import { EarningsCalendarEntry, EnrichedStock, OpportunityThesis } from "./types";

function fmtMarketCap(mc?: number): string {
  if (!mc) return "Unavailable";
  if (mc >= 1e12) return `$${(mc / 1e12).toFixed(2)}T`;
  if (mc >= 1e9) return `$${(mc / 1e9).toFixed(2)}B`;
  if (mc >= 1e6) return `$${(mc / 1e6).toFixed(0)}M`;
  return `$${mc}`;
}

function sentimentHebrew(score?: number, label?: string): string {
  const l = (label ?? "").toLowerCase();
  if (l.includes("bull") || (score ?? 0) > 0.15) return "חיובי";
  if (l.includes("bear") || (score ?? 0) < -0.15) return "שלילי";
  return "ניטרלי";
}

// "What changed recently" – the most relevant (non-promotional) real
// headline for this stock, never a template sentence.
function whatChangedHebrew(s: EnrichedStock): string {
  const item = pickRelevantNews(s.news);
  if (!item) return "אין ידיעה רלוונטית וטרייה זמינה עבור מניה זו כרגע.";
  const tone = sentimentHebrew(item.sentimentScore, item.sentimentLabel);
  return `לאחרונה: "${item.title}" (${item.source}) – סנטימנט ${tone}.`;
}

// Concrete, real numbers – never a bucketed "Large-Cap" label, so two
// different mega-caps can't produce identical text.
function keyMetricHebrew(s: EnrichedStock): string {
  const p = s.profile;
  const parts: string[] = [];
  parts.push(`שווי שוק: ${fmtMarketCap(p?.marketCap)}`);
  parts.push(p?.peRatio ? `P/E: ${p.peRatio.toFixed(1)}x` : "P/E: Unavailable");
  parts.push(
    p?.profitMargin !== undefined ? `שולי רווח: ${(p.profitMargin * 100).toFixed(0)}%` : "שולי רווח: Unavailable"
  );
  return parts.join(" · ");
}

// Real earnings-calendar lookup for this specific ticker – never invented.
function catalystHebrew(ticker: string, earningsCalendar: EarningsCalendarEntry[]): string {
  const entry = earningsCalendar.find((e) => e.ticker === ticker);
  if (!entry) return "אין אירוע רווחים קרוב מאושר בטווח הנראה לעין.";
  const timing = entry.timeOfDay === "pre-market" ? "לפני פתיחת המסחר" : entry.timeOfDay === "post-market" ? "לאחר סגירת המסחר" : "שעה לא מאושרת";
  return `דיווח רווחים ב-${entry.reportDate} (בעוד ${entry.daysRemaining} ימים, ${timing}).`;
}

const GENERIC_RISK = "סיכון שוק כללי – אף מניה אינה חסינה מתנודות מאקרו, ריבית או חדשות גיאופוליטיות.";

// listRisksHebrew() falls back to a generic market-risk line when no
// specific trigger (high volatility, negative news, expensive P/E, etc.)
// fires – which happens often for stable mega-caps once promotional/
// low-value news has been filtered out. That generic line is identical
// across every stock, so it must never be the "main risk" shown on a Top
// Opportunity card. This walks a chain of real, stock-specific numbers
// (P/E -> profit margin -> market cap + sector -> sector alone -> volume)
// so two different stocks can share this fallback path only if they
// genuinely share the same underlying numbers – never just from having the
// same generic template.
function mainRiskHebrew(s: EnrichedStock, risks: string[]): string {
  // listRisksHebrew() also has boilerplate messages for "no catalyst" / mixed
  // or negative news / "in the losers list" that carry no real number at
  // all – two quiet stocks with no news would otherwise collide on the exact
  // same sentence. Only accept a risk as genuinely stock-specific when it
  // embeds a real number (volatility %, market cap, P/E, etc.); otherwise
  // fall through to the real-data chain below.
  const specific = risks.find((r) => r !== GENERIC_RISK && /\d/.test(r));
  if (specific) return specific;

  const p = s.profile;
  if (p?.peRatio && p.peRatio > 0) {
    return `תמחור בפרמיה (P/E ${p.peRatio.toFixed(1)}x) – רגישות גבוהה לכל אכזבה ברווחיות או בהכוונה (Guidance) הבאה.`;
  }
  if (p?.profitMargin !== undefined) {
    return `שולי הרווח הנוכחיים (${(p.profitMargin * 100).toFixed(0)}%) הם הבסיס לתמחור – כל שחיקה בהם תפגע ביחס ישיר בהערכת השווי.`;
  }
  const sectorLabel = p?.sector || p?.industry;
  if (p?.marketCap) {
    return `שווי שוק גבוה (${fmtMarketCap(p.marketCap)})${sectorLabel ? ` בסקטור ${sectorLabel}` : ""} – כל האטה בקצב הצמיחה משפיעה משמעותית על התמחור.`;
  }
  if (sectorLabel) {
    return `חשיפה מרוכזת לסקטור ${sectorLabel} – רגישה למחזוריות ולתחרות בענף.`;
  }
  return `${GENERIC_RISK} (נפח מסחר יומי: ${s.volume.toLocaleString("en-US")})`;
}

// What would break the thesis – built from the SAME real numbers driving the
// stock's own risk profile, so it's tied to a concrete, checkable trigger
// rather than a generic warning that could apply to any stock.
function invalidationHebrew(s: EnrichedStock): string {
  const p = s.profile;
  const triggers: string[] = [];

  if (p?.peRatio && p.peRatio > 60) {
    triggers.push(`יחס ה-P/E הגבוה (${p.peRatio.toFixed(0)}x) לא יתממש בצמיחת רווחים בפועל ברבעונים הקרובים`);
  }
  if (p?.profitMargin !== undefined && p.profitMargin > 0) {
    triggers.push(`שולי הרווח הנוכחיים (${(p.profitMargin * 100).toFixed(0)}%) יתכווצו משמעותית`);
  }
  if (p?.eps !== undefined && p.eps < 0) {
    triggers.push("החברה לא תציג מסלול ברור לרווחיות תוך מספר רבעונים");
  }
  if (Math.abs(s.changePercent) >= 8) {
    triggers.push(`התנועה החדה של היום (${Math.abs(s.changePercent).toFixed(1)}%) תתברר כתחילת מגמה ולא כתיקון חד-פעמי`);
  }
  if (p?.marketCap !== undefined && p.marketCap < 10_000_000_000) {
    triggers.push(`שווי השוק היחסית קטן (${fmtMarketCap(p.marketCap)}) יגרור תנודתיות ונזילות נמוכה בזמן לחץ`);
  }
  if (triggers.length === 0) {
    triggers.push("היסודות הנוכחיים (רווחיות, שווי שוק, מומנטום) יתדרדרו משמעותית לעומת המצב כיום");
  }

  return `התזה תיפגע אם ${triggers[0]}.`;
}

export function buildOpportunityThesis(
  s: EnrichedStock,
  earningsCalendar: EarningsCalendarEntry[]
): OpportunityThesis {
  // A Top Opportunity must never be justified by a low-value headline (small
  // institutional-position disclosure, routine insider sale, ETF mechanics,
  // legal solicitation) – recompute "why today" from filtered news rather
  // than reusing the pipeline's pre-computed whyHebrew, which was built from
  // the FULL unfiltered news list and can quote exactly such a headline.
  const relevantNews = s.news.filter((n) => !isPromotionalOrLegalNews(n));
  const whyToday = explainWhyHebrew(s, s.profile, relevantNews);

  const risks = listRisksHebrew(s, s.profile, relevantNews);
  return {
    whyToday,
    whatChanged: whatChangedHebrew(s),
    keyMetric: keyMetricHebrew(s),
    catalyst: catalystHebrew(s.ticker, earningsCalendar),
    mainRisk: mainRiskHebrew(s, risks),
    invalidation: invalidationHebrew(s),
  };
}
