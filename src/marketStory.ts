import {
  isDirectlyAboutCompany,
  isPromotionalOrLegalNews,
  materiality,
  MaterialityCategory,
  MATERIALITY_HEBREW,
  sourceQualityScore,
  sourceTier,
} from "./newsFilter";
import { EarningsCalendarEntry, EnrichedStock, MarketStory, NewsItem, ReportData } from "./types";
import { watchlistName } from "./universe";

// ===== helpers =====

function displayName(s: EnrichedStock): string {
  return s.profile?.name ?? watchlistName(s.ticker) ?? s.ticker;
}

// Parse Alpha Vantage's "YYYYMMDDTHHMMSS" timestamp into a Date (UTC).
function parsePublished(raw: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(raw ?? "");
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return Number.isNaN(date.getTime()) ? null : date;
}

function fmtPublished(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// Dedupe a list of stocks by ticker, keeping the first occurrence.
function dedupe(stocks: EnrichedStock[]): EnrichedStock[] {
  const seen = new Set<string>();
  const out: EnrichedStock[] = [];
  for (const s of stocks) {
    if (!s || seen.has(s.ticker)) continue;
    seen.add(s.ticker);
    out.push(s);
  }
  return out;
}

interface ScoredNews {
  stock: EnrichedStock;
  item: NewsItem;
  date: Date;
  score: number;
}

// Primary window: only news published within the last 24h qualifies for a
// normal (unlabeled) Market Story. Fallback: widened to 48h ONLY when
// nothing in the primary window qualifies – and the result is always
// tagged `isFallback: true` so every renderer must show FALLBACK_NOTICE
// rather than presenting an up-to-2-day-old story as if it were fresh. No
// window wider than 48h is ever used for the hero story – see pipeline.ts.
export const PRIMARY_WINDOW_HOURS = 24;
export const FALLBACK_WINDOW_HOURS = 48;
// Exact, literal label every renderer must show when isFallback is true.
export const FALLBACK_NOTICE = "Fallback: no material story found in the last 24h";
// Minimum meaningfulness score for a story to be worth featuring.
const MIN_SCORE = 0.18;

// Genuinely market-wide / macro developments – used ONLY as a fallback pool
// when no candidate is directly about a specific company, so the hero slot
// never sits empty on a day where the real story is systemic (a Fed
// decision, a broad rally/selloff) rather than company-specific. Every
// matched item is still a real, already-fetched article – nothing here
// fabricates content, it only widens WHICH real articles are eligible.
const MACRO_KEYWORDS =
  /\bfederal reserve\b|\bfed\b.{0,15}\brate\b|interest rate decision|inflation (?:data|report)|\bcpi\b (?:data|report)|jobs report|unemployment report|market (?:rally|selloff|sell-off)|stocks? (?:rally|surge|tumble|sink|plunge)\b|\bs&p ?500\b|\bnasdaq (?:composite|index)\b|broader? market/i;

// Rank a single news item: relevance + sentiment strength + recency. We do
// NOT invent anything – every field comes straight from the feed.
// `requireDirectRelevance` gates the company-story pool (headline must
// actually be about the company, not merely tagged relevant by the
// provider) vs. the macro fallback pool (gated by MACRO_KEYWORDS instead,
// in scoreAllCandidates below).
function scoreNews(
  stock: EnrichedStock,
  item: NewsItem,
  now: number,
  windowHours: number,
  requireDirectRelevance: boolean
): ScoredNews | null {
  if (!item.title || !item.url) return null; // need a real headline + link
  // Promotional / law-firm solicitation / ETF / automated-move headlines
  // carry ~zero investment value and are never material company
  // developments – hard exclude rather than merely down-rank, so they can
  // never win a story slot.
  if (isPromotionalOrLegalNews(item)) return null;
  if (requireDirectRelevance && !isDirectlyAboutCompany(stock.ticker, displayName(stock), item)) {
    return null;
  }

  const date = parsePublished(item.publishedAt);
  if (!date) return null;

  const hoursAgo = (now - date.getTime()) / 3_600_000;
  if (hoursAgo < 0 || hoursAgo > windowHours) return null; // not recent enough for this window

  const recency = Math.max(0, 1 - hoursAgo / windowHours);
  // Materiality boost ranked by category (earnings/results and guidance rank
  // above a bare analyst price-target tweak) so genuinely material
  // developments win ties against generic market-noise headlines – never a
  // hard requirement, see newsFilter.ts's materiality().
  const materialityBoost = materiality(item).weight;

  // Scored as a weighted average over the factors that are ACTUALLY present,
  // renormalized by the weights used. Relevance and sentiment are supplied by
  // Alpha Vantage but not by Finnhub's free company-news endpoint; scoring a
  // missing factor as a low default (the previous behaviour: relevance 0.3,
  // impact 0) systematically ranked every Finnhub headline below every Alpha
  // Vantage one regardless of the story itself. Renormalizing removes that
  // provider bias without fabricating scores Finnhub never sent.
  const factors: Array<{ value: number; weight: number }> = [
    { value: recency, weight: 0.22 },
    { value: sourceQualityScore(item), weight: 0.15 },
  ];
  if (item.relevanceScore !== undefined) {
    factors.push({ value: Math.min(Math.max(item.relevanceScore, 0), 1), weight: 0.35 });
  }
  if (item.sentimentScore !== undefined) {
    factors.push({ value: Math.min(Math.abs(item.sentimentScore), 1), weight: 0.28 });
  }
  const totalWeight = factors.reduce((acc, f) => acc + f.weight, 0);
  const base = factors.reduce((acc, f) => acc + f.value * f.weight, 0) / totalWeight;

  const score = base + materialityBoost;
  return { stock, item, date, score };
}

function sentimentHebrew(item: NewsItem): string {
  const label = (item.sentimentLabel ?? "").toLowerCase();
  const score = item.sentimentScore ?? 0;
  if (label.includes("bull") || score > 0.15) return "חיובי";
  if (label.includes("bear") || score < -0.15) return "שלילי";
  return "ניטרלי";
}

// Numbers that appear in the headline itself (percentages, dollar amounts,
// explicit figures) – quoted back verbatim so "what happened" carries the
// actual facts rather than a paraphrase. Never computed or inferred.
function headlineFigures(title: string): string[] {
  const found = title.match(/\$\s?[\d.,]+\s*(?:billion|million|bn|m\b)?|\b\d+(?:\.\d+)?%/gi) ?? [];
  return Array.from(new Set(found.map((f) => f.trim()))).slice(0, 4);
}

// ===== WHAT HAPPENED =====
function buildSummaryHebrew(s: ScoredNews): string {
  const name = displayName(s.stock);
  const sector = s.stock.profile?.industry || s.stock.profile?.sector;
  const cat = materiality(s.item).category;
  const tier = sourceTier(s.item);
  const sentences: string[] = [];

  sentences.push(
    `${name} (${s.stock.ticker})${sector ? ` מסקטור ${sector}` : ""} – ${MATERIALITY_HEBREW[cat]}.`
  );
  sentences.push(`הידיעה: "${s.item.title}" (${s.item.source}, ${fmtPublished(s.date)}).`);

  const figures = headlineFigures(s.item.title);
  if (figures.length > 0) {
    sentences.push(`נתונים שמופיעים בכותרת: ${figures.join(" · ")}.`);
  }
  if (tier === "promotional") {
    sentences.push("הידיעה הגיעה דרך ערוץ הודעות לעיתונות של החברה – מקור מעניין אך לא בלתי-תלוי.");
  }
  return sentences.join(" ");
}

// ===== MARKET REACTION =====
// Reports the move that was actually measured, and explicitly declines to
// attribute it to the story. A headline appearing on the same day as a price
// move is not evidence that it caused it.
function buildMarketReactionHebrew(s: ScoredNews): string {
  if (!(s.stock.price > 0)) {
    return "לא נרשם מחיר עדכני זמין למניה בזמן הפקת הדוח, ולכן לא ניתן להציג את תגובת השוק.";
  }
  const dir = s.stock.changePercent >= 0 ? "עלתה" : "ירדה";
  const move = Math.abs(s.stock.changePercent).toFixed(2);
  const parts = [
    `המניה ${dir} ב-${move}% ונסחרת סביב $${s.stock.price.toFixed(2)}.`,
  ];
  if (s.stock.volume > 0) {
    parts.push(`המחזור עמד על כ-${(s.stock.volume / 1_000_000).toFixed(1)}M מניות.`);
  }
  parts.push("הקשר הסיבתי בין הידיעה לתנועת המחיר לא אומת – מדובר בשני נתונים שנצפו באותו יום.");
  return parts.join(" ");
}

// ===== WHY IT MATTERS =====
// Grounded in the KIND of event that actually happened plus this company's
// own verified numbers. Deliberately does NOT seed from
// explainLongTermWhyHebrew: that produces generic index-membership /
// market-cap-stability / growth-sector boilerplate which says nothing about
// today's event and was appearing verbatim as the explanation for it.
const WHY_BY_CATEGORY: Record<MaterialityCategory, string> = {
  earnings:
    "תוצאות בפועל הן הנתון היחיד שמאמת או מפריך את התזה – הן קובעות את קצב הצמיחה והרווחיות שהשוק מתמחר קדימה.",
  guidance:
    "עדכון תחזית משנה את הציפיות העתידיות, ולרוב משפיע על התמחור יותר מהרבעון שכבר דווח.",
  ma: "מיזוג או רכישה משנים את מבנה החברה, את הקצאת ההון ואת תמונת התחרות – השפעה מבנית ולא רבעונית.",
  contract:
    "חוזה או שותפות מהותית מתורגמים להכנסות עתידיות, ומעידים על מיצוב תחרותי מול לקוחות גדולים.",
  regulation:
    "התפתחות רגולטורית או משפטית יכולה להגביל מודל עסקי או ליצור חשיפה כספית – סיכון שאינו מופיע בדוחות הרבעוניים.",
  management:
    "חילופי הנהלה בכירה משפיעים על אסטרטגיה והמשכיות ניהולית, במיוחד כשהם לא מתוכננים.",
  analystAction:
    "עדכון אנליסטים משקף שינוי בציפיות השוק, אך אינו נתון עסקי של החברה עצמה – משקל מוגבל בתזה ארוכת טווח.",
  productStrategic:
    "מהלך מוצרי או אסטרטגי מעיד על כיוון ההשקעה של החברה ועל מקורות הצמיחה שהיא מכוונת אליהם.",
  marketImpact:
    "מדובר בתנועה רוחבית בשוק ולא באירוע ספציפי לחברה – ההשפעה על התזה הפרטנית מוגבלת.",
  none: "לא זוהתה קטגוריית אירוע מובהקת, ולכן המשקל של הידיעה בתזה ארוכת הטווח מוגבל.",
};

function buildWhyMattersHebrew(s: ScoredNews): string {
  const cat = materiality(s.item).category;
  const parts: string[] = [WHY_BY_CATEGORY[cat]];

  // One concrete, verified company fact tied to the event – never a generic
  // "large cap provides stability" line.
  const p = s.stock.profile;
  if (cat === "earnings" || cat === "guidance") {
    if (p?.eps !== undefined) {
      parts.push(
        p.eps > 0
          ? `נקודת הייחוס: החברה רווחית כיום (EPS ${p.eps.toFixed(2)})${p.profitMargin !== undefined ? `, שולי רווח כ-${(p.profitMargin * 100).toFixed(0)}%` : ""}.`
          : `נקודת הייחוס: החברה עדיין לא רווחית (EPS ${p.eps.toFixed(2)}), ולכן לתוצאות משקל גבוה במיוחד.`
      );
    }
    if (p?.peRatio !== undefined && p.peRatio > 0) {
      parts.push(`המכפיל הנוכחי עומד על כ-${p.peRatio.toFixed(1)}, והוא זה שנבחן מול התוצאות.`);
    }
  } else if (p?.marketCap !== undefined && (cat === "ma" || cat === "contract" || cat === "regulation")) {
    parts.push(
      `סדר הגודל הרלוונטי: שווי שוק של כ-$${(p.marketCap / 1_000_000_000).toFixed(1)}B, שמולו יש למדוד את היקף האירוע.`
    );
  }

  return parts.join(" ");
}

// ===== WHAT TO WATCH NEXT =====
// Prefers a real, verified date from the earnings calendar. Falls back to the
// concrete open question implied by the event category. Never invents a date.
const WATCH_BY_CATEGORY: Record<MaterialityCategory, string> = {
  earnings: "האם קצב הצמיחה והשוליים שדווחו יישמרו ברבעון הבא, ומה תהיה התחזית שתלווה אותו.",
  guidance: "האם התחזית המעודכנת תאושר בתוצאות בפועל, או תעודכן שוב.",
  ma: "אישורים רגולטוריים, מועד ההשלמה בפועל, ותנאי המימון של העסקה.",
  contract: "מתי ההכנסות מהחוזה יתחילו להיכנס לדוחות, והאם ייחתמו חוזים דומים נוספים.",
  regulation: "לוח הזמנים של ההליך, החלטות ביניים, וההיקף הכספי שייקבע בסופו.",
  management: "מינוי הקבוע לתפקיד והאם האסטרטגיה המוצהרת משתנה בעקבותיו.",
  analystAction: "האם בתי השקעות נוספים יעדכנו את המלצותיהם באותו כיוון.",
  productStrategic: "קצב האימוץ בפועל והשפעתו על ההכנסות ברבעונים הקרובים.",
  marketImpact: "נתוני מאקרו והחלטות ריבית שימשיכו להניע את המגמה הרוחבית.",
  none: "התפתחויות מהותיות נוספות שיבססו או יסתרו את הידיעה.",
};

function buildWhatToWatchHebrew(s: ScoredNews, calendar: EarningsCalendarEntry[]): string {
  const cat = materiality(s.item).category;
  const parts: string[] = [];

  const upcoming = calendar.find((e) => e.ticker === s.stock.ticker && e.daysRemaining >= 0);
  if (upcoming) {
    const timing = upcoming.timeOfDay === "pre-market" ? " (לפני הפתיחה)" : upcoming.timeOfDay === "post-market" ? " (אחרי הסגירה)" : "";
    parts.push(
      `קטליזטור מאומת בלוח השנה: דוח כספי ב-${upcoming.reportDate}${timing}, בעוד ${upcoming.daysRemaining} ימים.`
    );
  }
  parts.push(WATCH_BY_CATEGORY[cat]);
  return parts.join(" ");
}

function toMarketStory(s: ScoredNews, isFallback: boolean, calendar: EarningsCalendarEntry[]): MarketStory {
  return {
    ticker: s.stock.ticker,
    companyName: displayName(s.stock),
    headline: s.item.title,
    url: s.item.url,
    source: s.item.source,
    publishedAt: s.item.publishedAt,
    publishedDisplay: fmtPublished(s.date),
    sentimentLabel: s.item.sentimentLabel,
    summaryHebrew: buildSummaryHebrew(s),
    marketReactionHebrew: buildMarketReactionHebrew(s),
    whyMattersHebrew: buildWhyMattersHebrew(s),
    whatToWatchHebrew: buildWhatToWatchHebrew(s, calendar),
    originalSummary: s.item.summary,
    priceMove: s.stock.price > 0 ? { price: s.stock.price, changePercent: s.stock.changePercent } : undefined,
    // No safe/licensed logo source is wired in, so renderers use the ticker
    // placeholder. Leave undefined rather than hotlink a copyrighted image.
    logoUrl: undefined,
    isFallback,
    materialityCategory: materiality(s.item).category,
  };
}

// The report's stocks with any news/technical signal at all – shared by
// both the company-story pool and the macro-fallback pool below.
function candidatePool(data: ReportData): EnrichedStock[] {
  const techTickers = new Set([
    ...data.technicalAlerts.aboveUpper.map((a) => a.ticker),
    ...data.technicalAlerts.belowLower.map((a) => a.ticker),
  ]);
  return dedupe([
    ...data.topOpportunities,
    ...data.core,
    ...data.growth,
    ...data.speculative,
    ...data.watchlist,
  ]).filter((s) => s.news.length > 0 || techTickers.has(s.ticker));
}

// Company-specific candidates: the headline must genuinely be about that
// stock (see isDirectlyAboutCompany) – this is what keeps an ETF article or
// an unrelated-company headline from ever winning a "Market Story" slot just
// because the provider tagged it relevant.
function scoreCompanyCandidates(data: ReportData, nowMs: number, windowHours: number): ScoredNews[] {
  const bestPerStock: ScoredNews[] = [];
  for (const stock of candidatePool(data)) {
    let best: ScoredNews | null = null;
    for (const item of stock.news) {
      const scored = scoreNews(stock, item, nowMs, windowHours, true);
      if (scored && (!best || scored.score > best.score)) best = scored;
    }
    if (best && best.score >= MIN_SCORE) bestPerStock.push(best);
  }
  bestPerStock.sort((a, b) => b.score - a.score);
  return bestPerStock;
}

// Market-wide/macro fallback – used ONLY when no company-specific candidate
// qualifies (see scoreAllCandidates). Still a real, already-fetched article;
// this never invents content, only widens which real article can fill the
// hero slot.
function scoreMacroCandidates(data: ReportData, nowMs: number, windowHours: number): ScoredNews[] {
  const macro: ScoredNews[] = [];
  for (const stock of candidatePool(data)) {
    for (const item of stock.news) {
      if (!MACRO_KEYWORDS.test(item.title ?? "")) continue;
      const scored = scoreNews(stock, item, nowMs, windowHours, false);
      if (scored && scored.score >= MIN_SCORE) macro.push(scored);
    }
  }
  macro.sort((a, b) => b.score - a.score);
  return macro;
}

// Company story first; only when NOTHING there qualifies does a genuine
// market-wide development fill the slot instead. Both pools can legitimately
// come back empty – the caller then shows an honest "no story today"
// message rather than padding the hero slot with low-value news.
function scoreAllCandidates(data: ReportData, nowMs: number, windowHours: number): ScoredNews[] {
  const company = scoreCompanyCandidates(data, nowMs, windowHours);
  if (company.length > 0) return company;
  return scoreMacroCandidates(data, nowMs, windowHours);
}

// ===== public API =====

// Pick the single most meaningful recent news story across the report's
// stocks, trying the 24h primary window first and falling back to 48h ONLY
// when the primary window found nothing (see pipeline.ts) – the fallback
// result is always tagged isFallback so no renderer can present a
// (up-to-2-day-old) story as if it were today's. Returns null when nothing
// qualifies even within 48h.
export function selectMarketStory(
  data: ReportData,
  nowMs: number,
  windowHours: number = PRIMARY_WINDOW_HOURS
): MarketStory | null {
  const candidates = scoreAllCandidates(data, nowMs, windowHours);
  return candidates.length > 0
    ? toMarketStory(candidates[0], windowHours > PRIMARY_WINDOW_HOURS, data.earningsCalendar ?? [])
    : null;
}

// Up to `count` more relevant, distinct-ticker headlines beyond the hero
// story – short items for the "Market Story + N additional headlines" slot.
export function selectAdditionalHeadlines(
  data: ReportData,
  nowMs: number,
  count = 2,
  windowHours: number = PRIMARY_WINDOW_HOURS
): MarketStory[] {
  const candidates = scoreAllCandidates(data, nowMs, windowHours);
  if (candidates.length === 0) return [];
  const [hero, ...rest] = candidates;
  const calendar = data.earningsCalendar ?? [];
  return rest
    .filter((c) => c.stock.ticker !== hero.stock.ticker)
    .slice(0, count)
    .map((c) => toMarketStory(c, windowHours > PRIMARY_WINDOW_HOURS, calendar));
}
