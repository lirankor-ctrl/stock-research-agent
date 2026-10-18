// One display model for the Bollinger section, consumed by every renderer
// (HTML attachment, email HTML, Markdown, plain text). All wording and number
// formatting is decided HERE, once, so the four surfaces cannot drift apart –
// the renderers only decide layout.
import { usMarketDateIso, US_MARKET_TZ, zonedParts } from "../dateUtils";
import { fmtBigDollar } from "../reportPresentation";
import { SETUP_HEBREW, statusHebrew } from "./research";
import { BollingerReport } from "./types";

export const BOLLINGER_TITLE = "🎯 Bollinger Opportunity of the Day";
export const BOLLINGER_SUBTITLE = "הזדמנות הבולינגר היומית – סריקה רחבה של מניות אמריקאיות נזילות";
export const NO_PICK_TITLE = "No high-confidence Bollinger opportunity today";
export const BOLLINGER_DISCLAIMER =
  "ניתוח טכני בלבד – אינו המלצה ואינו ייעוץ השקעות. יעדים ורמות הם רמות ייחוס טכניות ולא תחזית; אותות טכניים נכשלים לעיתים קרובות.";

export interface ViewNewsLink {
  title: string;
  url: string;
  meta: string;
}

export interface ViewBlock {
  title: string;
  paragraphs: string[];
  bullets: string[];
  links: ViewNewsLink[];
}

export interface BollingerView {
  kind: "selected" | "none" | "unavailable";
  ticker?: string;
  companyName?: string;
  sectorLine?: string;
  setupLabel?: string;
  statusLabel?: string;
  score?: string;
  sessionLabel?: string;
  priceLine?: string;
  repeatNote?: string;
  snapshot: Array<[string, string]>;
  plan: Array<[string, string]>;
  blocks: ViewBlock[];
  scoreRows: Array<[string, string, string]>;
  penalties: string[];
  noneReason?: string;
  radar: Array<[string, string, string, string, string]>; // ticker, setup, status, score, close/RSI
  methodology: string;
}

const usd = (n: number | null | undefined) => (n === null || n === undefined ? "לא זמין" : `$${n.toFixed(2)}`);
const fix = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? "לא זמין" : n.toFixed(d));

export function fmtEt(iso: string): string {
  const d = new Date(iso);
  const p = zonedParts(d, US_MARKET_TZ);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${usMarketDateIso(d)} ${pad(p.hour)}:${pad(p.minute)} ET`;
}

function block(title: string, parts: Partial<ViewBlock>): ViewBlock {
  return { title, paragraphs: parts.paragraphs ?? [], bullets: parts.bullets ?? [], links: parts.links ?? [] };
}

function methodologyLine(r: BollingerReport): string {
  const s = r.stats;
  return (
    `שיטה: SMA20 ± 2σ על מחירי סגירה מותאמים (${s.adjustment}), Yahoo Finance יומי · סשן אחרון שהושלם: ${s.expectedSession ?? "—"} · ` +
    `נסרקו ${s.universe} · נתונים ל-${s.fetched} · לא עדכניים ${s.stale} · היסטוריה קצרה ${s.insufficientHistory} · ` +
    `הוחרגו (לא מניה/נזילות) ${s.excluded} · סטאפים ${s.setupsFound} (${s.confirmed} מאושרים) · סף בחירה ${r.minScore}/100.`
  );
}

function radarRows(r: BollingerReport): BollingerView["radar"] {
  return r.radar.map((i) => [
    i.symbol,
    SETUP_HEBREW[i.type].split(" – ")[0],
    i.status === "confirmed" ? "מאושר" : "מתהווה",
    `${i.score.toFixed(1)}/100`,
    `$${i.close.toFixed(2)} · RSI ${i.rsi14 === null ? "—" : i.rsi14.toFixed(0)}`,
  ]);
}

export function buildBollingerView(r: BollingerReport): BollingerView {
  const base = { snapshot: [], plan: [], blocks: [], scoreRows: [], penalties: [], radar: radarRows(r), methodology: methodologyLine(r) };
  if (r.status === "unavailable" || (r.status === "none" && !r.pick)) {
    return {
      ...base,
      kind: r.status === "unavailable" ? "unavailable" : "none",
      noneReason: r.noneReasonHebrew ?? (r.status === "unavailable" ? "נתוני מחיר לסריקה לא היו זמינים בריצה זו." : undefined),
    };
  }
  const p = r.pick!;
  const c = p.candidate;
  const s = c.snapshot;
  const res = p.research;
  const quote = c.series.quote;

  const snapshot: Array<[string, string]> = [
    ["SMA20", usd(s.sma20)],
    ["Upper band", usd(s.upper)],
    ["Lower band", usd(s.lower)],
    ["%B", fix(s.percentB)],
    ["Bandwidth", `${(s.bandwidth * 100).toFixed(1)}%`],
    ["BW percentile", s.bandwidthPercentile === null ? "לא זמין" : `${s.bandwidthPercentile.toFixed(0)} (${s.bandwidthHistory} תצפיות)`],
    ["RSI(14)", fix(s.rsi14, 1)],
    ["Rel. volume", s.relVolume === null ? "לא זמין" : `${s.relVolume.toFixed(2)}×`],
    ["MA50", usd(s.ma50)],
    ["MA200", usd(s.ma200)],
    ["ATR(14)", usd(s.atr14)],
  ];

  const plan: Array<[string, string]> = [
    ["טריגר כניסה מותנה", p.plan.entryTriggerHebrew],
    ["ביטול / רמת סטופ לייחוס", p.plan.stopHebrew],
    ["תרחיש עלייה טכני", p.plan.targetHebrew],
    ["סיכוי/סיכון (משוער)", p.plan.riskReward === null ? "לא ניתן להעריך מהנתונים" : `1 : ${p.plan.riskReward.toFixed(2)}`],
  ];

  const fundamentals = [
    `שווי שוק: ${res.marketCap !== undefined ? fmtBigDollar(res.marketCap) : "לא זמין"}`,
    `מכפיל רווח (P/E): ${res.peRatio !== undefined ? res.peRatio.toFixed(1) : "לא זמין"}`,
    `רווח למניה (EPS): ${res.eps !== undefined ? `$${res.eps.toFixed(2)}` : "לא זמין"}`,
    `שולי רווח נקי: ${res.profitMargin !== undefined ? `${(res.profitMargin * 100).toFixed(1)}%` : "לא זמין"}`,
    `תשואת דיבידנד: ${res.dividendYield !== undefined && res.dividendYield > 0 ? `${(res.dividendYield * 100).toFixed(2)}%` : "אין / לא זמין"}`,
    `טווח 52 שבועות: ${usd(c.series.fiftyTwoWeekLow)} – ${usd(c.series.fiftyTwoWeekHigh)}`,
  ];
  const description = res.description
    ? `${res.description.length > 420 ? `${res.description.slice(0, 420).trim()}…` : res.description} (תיאור הספק, באנגלית)`
    : "תיאור עסקי לא זמין מספק הנתונים בריצה זו.";

  const newsLinks: ViewNewsLink[] = res.news.map((n) => ({
    title: n.title,
    url: n.url,
    meta: `${n.source} · ${n.publishedAt.slice(0, 4)}-${n.publishedAt.slice(4, 6)}-${n.publishedAt.slice(6, 8)}`,
  }));
  const newsEmpty =
    res.newsSource.source === "unavailable"
      ? "ספק החדשות לא היה זמין בריצה זו – לא ניתן לאמת חדשות אחרונות."
      : "לא נמצאו ידיעות מהותיות ישירות על החברה בימים האחרונים.";

  const levels = [
    `תמיכות: ${p.plan.supports.length ? p.plan.supports.map((v) => `$${v.toFixed(2)}`).join(" · ") : "—"}`,
    `התנגדויות: ${p.plan.resistances.length ? p.plan.resistances.map((v) => `$${v.toFixed(2)}`).join(" · ") : "—"}`,
  ];

  return {
    ...base,
    kind: "selected",
    ticker: c.symbol,
    companyName: c.name,
    sectorLine: [res.sector, res.industry && res.industry !== res.sector ? res.industry : undefined].filter(Boolean).join(" · ") || "סקטור לא זמין",
    setupLabel: SETUP_HEBREW[c.signal.type],
    statusLabel: statusHebrew(c.signal.status),
    score: `${c.score.total.toFixed(1)}/100`,
    sessionLabel: `BOLLINGER PICK · סשן ${s.date}`,
    priceLine:
      (quote ? `מחיר אחרון: $${quote.price.toFixed(2)} (נכון ל-${fmtEt(quote.timeIso)})` : "מחיר עדכני לא זמין") +
      ` · סגירת סשן האות ${s.date}: $${c.series.bars[c.series.bars.length - 1].rawClose.toFixed(2)}`,
    repeatNote: p.repeatNoteHebrew,
    snapshot,
    plan,
    blocks: [
      block("למה המניה נבחרה – האות", { paragraphs: [p.signalExplanationHebrew, `מגמה ומומנטום: ${p.trendHebrew}`] }),
      block("פרופיל החברה", { paragraphs: [description], bullets: fundamentals }),
      block("חדשות מהותיות אחרונות", newsLinks.length ? { links: newsLinks } : { paragraphs: [newsEmpty] }),
      block("רמות טכניות חשובות", { bullets: levels }),
      block("תרחישים", { bullets: [`📈 שורי: ${p.bullishHebrew}`, `📉 דובי: ${p.bearishHebrew}`] }),
      block("סיכונים מרכזיים", { bullets: p.risksHebrew }),
      block("קטליזטורים קרובים", { bullets: p.catalystsHebrew }),
    ],
    scoreRows: c.score.components.map((k) => [k.label, `${k.points}/${k.max}`, k.note]),
    penalties: c.score.penalties.map((x) => `−${x.points}: ${x.note}`),
  };
}

// Machine-readable summary for reports/latest.json (additive field).
export function bollingerJsonSummary(r: BollingerReport) {
  const c = r.pick?.candidate;
  return {
    status: r.status,
    minScore: r.minScore,
    noneReason: r.noneReasonHebrew ?? null,
    pick: c
      ? {
          symbol: c.symbol,
          name: c.name,
          setup: c.signal.type,
          signalStatus: c.signal.status,
          score: c.score.total,
          sessionDate: c.snapshot.date,
          close: c.snapshot.close,
          entryTrigger: r.pick!.plan.entryTrigger,
          stopReference: r.pick!.plan.stopReference,
          target: r.pick!.plan.target,
          riskReward: r.pick!.plan.riskReward,
          components: c.score.components.map((k) => ({ key: k.key, points: k.points, max: k.max })),
          penalties: c.score.penalties.map((p) => ({ key: p.key, points: p.points })),
        }
      : null,
    radar: r.radar,
    stats: r.stats,
  };
}
