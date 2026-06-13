import { EnrichedStock, MarketStory, NewsItem, ReportData } from "./types";
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
  const date = new Date(
    Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
  );
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

// Only consider news published within the last `RECENT_DAYS` days.
const RECENT_DAYS = 10;
// Minimum meaningfulness score for a story to be worth featuring.
const MIN_SCORE = 0.18;

// Rank a single news item: relevance + sentiment strength + recency. We do NOT
// invent anything – every field comes straight from the feed.
function scoreNews(stock: EnrichedStock, item: NewsItem, now: number): ScoredNews | null {
  if (!item.title || !item.url) return null; // need a real headline + link
  const date = parsePublished(item.publishedAt);
  if (!date) return null;

  const hoursAgo = (now - date.getTime()) / 3_600_000;
  if (hoursAgo < 0 || hoursAgo > RECENT_DAYS * 24) return null; // not recent

  const relevance = item.relevanceScore ?? 0.3;
  const impact = Math.min(Math.abs(item.sentimentScore ?? 0), 1);
  const recency = Math.max(0, 1 - hoursAgo / (RECENT_DAYS * 24));

  const score = relevance * 0.4 + impact * 0.35 + recency * 0.25;
  return { stock, item, date, score };
}

function sentimentHebrew(item: NewsItem): string {
  const label = (item.sentimentLabel ?? "").toLowerCase();
  const score = item.sentimentScore ?? 0;
  if (label.includes("bull") || score > 0.15) return "חיובי";
  if (label.includes("bear") || score < -0.15) return "שלילי";
  return "ניטרלי";
}

function buildSummaryHebrew(s: ScoredNews): string {
  const name = displayName(s.stock);
  const sector = s.stock.profile?.industry || s.stock.profile?.sector;
  const tone = sentimentHebrew(s.item);
  const sentences: string[] = [];

  sentences.push(
    `${name} (${s.stock.ticker})${sector ? ` מסקטור ${sector}` : ""} בכותרות היום.`
  );
  sentences.push(`הידיעה המרכזית: "${s.item.title}" (מקור: ${s.item.source}).`);
  sentences.push(`הסנטימנט שזוהה בכתבה הוא ${tone}.`);

  if (s.stock.price > 0) {
    const dir = s.stock.changePercent >= 0 ? "עלתה" : "ירדה";
    sentences.push(
      `המניה ${dir} ב-${Math.abs(s.stock.changePercent).toFixed(2)}% ונסחרת סביב $${s.stock.price.toFixed(2)}.`
    );
  }

  sentences.push("לפרטים המלאים יש לעיין במקור המקושר – אין לראות בכך ייעוץ השקעות.");
  return sentences.join(" ");
}

function buildWhyMattersHebrew(s: ScoredNews): string {
  // Anchor on the stock's existing long-term rationale, then connect the news.
  const base = s.stock.longTermWhyHebrew?.trim();
  const tone = sentimentHebrew(s.item);
  const newsAngle =
    tone === "חיובי"
      ? "זרם חדשות חיובי עשוי לחזק את התזה ארוכת-הטווח, אך יש לאמת שהשיפור מבני ולא רעש קצר-טווח."
      : tone === "שלילי"
      ? "חדשות שליליות עשויות ליצור הזדמנות כניסה אם היסודות נותרו איתנים – או להיות סימן אזהרה; נדרשת בדיקה."
      : "ללא הטיה סנטימנטלית חזקה, הערך למשקיע ארוך-טווח תלוי ביסודות החברה יותר מבכותרת הבודדת.";
  return base ? `${base} ${newsAngle}` : newsAngle;
}

// ===== public API =====

// Pick the single most meaningful recent news story across the report's stocks
// (Top Opportunities, Watchlist Highlights, technical-alert names, full
// Watchlist). Returns null when nothing recent/meaningful is available.
export function selectMarketStory(data: ReportData, nowMs: number): MarketStory | null {
  const techTickers = new Set([
    ...data.technicalAlerts.aboveUpper.map((a) => a.ticker),
    ...data.technicalAlerts.belowLower.map((a) => a.ticker),
  ]);

  const pool = dedupe([
    ...data.topOpportunities,
    ...data.watchlistHighlights,
    ...data.core,
    ...data.growth,
    ...data.speculative,
    // Watchlist last so highlights/opportunities win ties on first-seen.
    ...data.watchlist,
  ]).filter((s) => s.news.length > 0 || techTickers.has(s.ticker));

  let best: ScoredNews | null = null;
  for (const stock of pool) {
    for (const item of stock.news) {
      const scored = scoreNews(stock, item, nowMs);
      if (scored && (!best || scored.score > best.score)) best = scored;
    }
  }

  if (!best || best.score < MIN_SCORE) return null;

  return {
    ticker: best.stock.ticker,
    companyName: displayName(best.stock),
    headline: best.item.title,
    url: best.item.url,
    source: best.item.source,
    publishedAt: best.item.publishedAt,
    publishedDisplay: fmtPublished(best.date),
    sentimentLabel: best.item.sentimentLabel,
    summaryHebrew: buildSummaryHebrew(best),
    whyMattersHebrew: buildWhyMattersHebrew(best),
    originalSummary: best.item.summary,
    priceMove: best.stock.price > 0
      ? { price: best.stock.price, changePercent: best.stock.changePercent }
      : undefined,
    // No safe/licensed logo source is wired in, so renderers use the ticker
    // placeholder. Leave undefined rather than hotlink a copyrighted image.
    logoUrl: undefined,
  };
}
