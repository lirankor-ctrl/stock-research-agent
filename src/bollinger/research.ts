// Technical plan + Hebrew narrative for the selected opportunity. Pure: built
// only from the candidate's own computed levels and the research data that
// was actually fetched. Targets are technical reference levels, never
// promised outcomes, and nothing company-specific is written without a
// sourced field behind it.
import { MATERIALITY_HEBREW, materiality } from "../newsFilter";
import { FearGreed } from "../types";
import { NewsRiskAssessment } from "./scoring";
import { BollingerCandidate, CompanyResearch, IndicatorSnapshot, ScorePenalty, SetupType, TechnicalPlan } from "./types";

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (from: number, to: number) => `${to >= from ? "+" : ""}${(((to - from) / from) * 100).toFixed(1)}%`;

export const SETUP_HEBREW: Record<SetupType, string> = {
  squeeze: "Bollinger Squeeze – פריצה מתוך התכווצות",
  breakout: "Confirmed Breakout – פריצה מעל הרצועה העליונה",
  meanReversion: "Mean Reversion – התאוששות מהרצועה התחתונה",
};

export function statusHebrew(status: "confirmed" | "emerging"): string {
  return status === "confirmed" ? "אות מאושר" : "סטאפ מתהווה (עדיין לא אות)";
}

function maxHigh(c: BollingerCandidate, sessions: number): number {
  return Math.max(...c.series.bars.slice(-sessions).map((b) => b.high));
}

// Levels by setup:
//   breakout / squeeze – entry = the signal close, valid only if the next
//     session HOLDS above it; stop = middle band (SMA20), capped at 2×ATR
//     when the middle band is >10% away; target = entry + the signal-day band
//     width (squeeze: or the squeeze range height, whichever is larger).
//     ⇒ R/R ≈ 1 / (%B − 0.5): the further a breakout is stretched outside
//     the band, the worse its R/R – which is exactly the chase risk.
//   mean reversion – entry = close above the reversal session's high
//     (follow-through); stop = the recent swing low; target = middle band,
//     or the upper band when price is already at the middle band.
export function buildTechnicalPlan(c: BollingerCandidate): TechnicalPlan {
  const s = c.snapshot;
  const isReversion = c.signal.type === "meanReversion";
  const entry = isReversion ? s.high : s.close;
  const atr = s.atr14;
  let stop: number;
  let stopHebrew: string;
  let target: number | null;
  let targetHebrew: string;

  if (isReversion) {
    stop = Math.min(...c.history.map((h) => h.low));
    stopHebrew = `סגירה מתחת לשפל האחרון ${usd(stop)} – ההתאוששות נכשלה`;
    target = s.sma20 > entry * 1.01 ? s.sma20 : s.upper;
    targetHebrew = s.sma20 > entry * 1.01 ? `חזרה לממוצע 20 (הרצועה האמצעית) ${usd(target)}` : `הרצועה העליונה ${usd(target)}`;
  } else {
    stop = s.sma20;
    stopHebrew = `סגירה מתחת לממוצע 20 (הרצועה האמצעית) ${usd(stop)} – חזרה לתוך הטווח = פריצת שווא`;
    if (atr !== null && (entry - stop) / entry > 0.1) {
      stop = entry - 2 * atr;
      stopHebrew = `סגירה מתחת ל-${usd(stop)} (2×ATR מתחת לטריגר) – הממוצע רחוק מדי לשמש כנקודת ביטול`;
    }
    const width = s.upper - s.lower;
    if (c.signal.type === "squeeze") {
      const prior = c.history.slice(0, -1);
      const rangeHeight = Math.max(...prior.map((h) => h.high)) - Math.min(...prior.map((h) => h.low));
      target = entry + Math.max(width, rangeHeight);
      targetHebrew = `מהלך מדוד: טריגר + max(רוחב הרצועות, גובה טווח ההתכווצות) ≈ ${usd(target)}`;
    } else {
      target = entry + width;
      targetHebrew = `הקרנת רוחב הרצועות (4σ) מעל הטריגר ≈ ${usd(target)}`;
    }
  }

  if (target !== null && target <= entry) target = null;
  const riskReward = target !== null && entry > stop ? (target - entry) / (entry - stop) : null;

  const close = s.close;
  const supports = [s.sma20, s.lower, s.ma50, stop].filter((v): v is number => v !== null && v < close);
  const resistances = [s.upper, maxHigh(c, 20), maxHigh(c, 252), target].filter((v): v is number => v !== null && v > close);
  const uniq = (xs: number[]) => Array.from(new Set(xs.map((x) => Math.round(x * 100) / 100)));

  return {
    entryTrigger: entry,
    entryTriggerHebrew: isReversion
      ? `סגירה יומית מעל ${usd(entry)} (שיא יום ההתאוששות), רצוי במחזור ≥ הממוצע`
      : `החזקה מעל ${usd(entry)} (סגירת יום הפריצה) בסשן הבא; חזרה מתחת לרמה = אין כניסה`,
    stopReference: stop,
    stopHebrew,
    target,
    targetHebrew: target === null ? "לא נקבע יעד – הרמות הנוכחיות לא תומכות בהערכה כנה" : targetHebrew,
    riskReward,
    supports: uniq(supports).sort((a, b) => b - a).slice(0, 3),
    resistances: uniq(resistances).sort((a, b) => a - b).slice(0, 3),
  };
}

export function signalExplanationHebrew(c: BollingerCandidate): string {
  const s = c.snapshot;
  const rv = s.relVolume !== null ? `פי ${s.relVolume.toFixed(1)} מהממוצע` : "מחזור לא זמין";
  const bwp = s.bandwidthPercentile !== null ? `אחוזון ${s.bandwidthPercentile.toFixed(0)}` : "אחוזון לא זמין";
  if (c.signal.type === "squeeze") {
    const minPct = Math.min(...c.history.map((h) => h.bandwidthPercentile ?? 100));
    return (
      `רוחב הרצועות ירד בימים האחרונים עד אחוזון ${minPct.toFixed(0)} של השנה האחרונה – התכווצות תנודתיות חריגה. ` +
      `בסשן ${s.date} המניה סגרה ב-${usd(s.close)}, מעל הרצועה העליונה (${usd(s.upper)}), במחזור ${rv}. ` +
      `%B=${s.percentB.toFixed(2)}; רוחב הרצועות כעת ${bwp}.`
    );
  }
  if (c.signal.type === "breakout") {
    return (
      `בסשן ${s.date} המניה סגרה ב-${usd(s.close)}, מעל הרצועה העליונה (${usd(s.upper)}; %B=${s.percentB.toFixed(2)}), ` +
      `במחזור ${rv} ובכיוון המגמה (מעל MA50). פריצה עם מחזור תומך היא המאפיין שמבדיל אותה מנגיעה רגעית ברצועה.`
    );
  }
  const minPctB = Math.min(...c.history.slice(0, -1).map((h) => h.percentB));
  return (
    `בימים האחרונים המניה ירדה אל/מתחת לרצועה התחתונה (%B מינימלי ${minPctB.toFixed(2)}). ` +
    `בסשן ${s.date} היא חזרה פנימה וסגרה ב-${usd(s.close)} – מעל שיא הסשן הקודם, עם RSI עולה ומחזור ${rv}. ` +
    `נגיעה ברצועה התחתונה לבדה אינה אות קנייה; כאן יש אישור התאוששות.`
  );
}

export function trendHebrew(s: IndicatorSnapshot): string {
  const parts: string[] = [];
  if (s.ma50 !== null) parts.push(`${s.close > s.ma50 ? "מעל" : "מתחת"} MA50 (${usd(s.ma50)})`);
  if (s.ma200 !== null) parts.push(`${s.close > s.ma200 ? "מעל" : "מתחת"} MA200 (${usd(s.ma200)})`);
  else parts.push("MA200 לא זמין (היסטוריה קצרה)");
  if (s.rsi14 !== null) parts.push(`RSI ${s.rsi14.toFixed(0)}`);
  if (s.relVolume !== null) parts.push(`מחזור יחסי ${s.relVolume.toFixed(2)}×`);
  return parts.join(" · ");
}

export function scenariosHebrew(c: BollingerCandidate, plan: TechnicalPlan): { bullish: string; bearish: string } {
  const e = plan.entryTrigger;
  const bullish =
    plan.target !== null
      ? `אם המניה תחזיק ותסגור מעל ${usd(e)} עם מחזור תומך, היעד הטכני הראשון הוא ${usd(plan.target)} (${pct(e, plan.target)} מהטריגר). ` +
        `זו רמת ייחוס טכנית – לא תחזית ולא הבטחה.`
      : `סגירה מעל ${usd(e)} תחזק את האות, אך הרמות הנוכחיות לא מאפשרות לקבוע יעד טכני כן.`;
  const bearish =
    `כישלון בהמשכיות (סגירה חזרה מתחת ל-${usd(e)}) מחליש את האות; סגירה מתחת ל-${usd(plan.stopReference)} ` +
    `(${pct(e, plan.stopReference)} מהטריגר) מבטלת אותו.` +
    (c.signal.type === "meanReversion" ? " ירידה חדשה מתחת לרצועה התחתונה תעיד על המשך מגמת הירידה." : " חזרה לתוך הרצועות מתחת לממוצע 20 אופיינית לפריצת שווא.");
  return { bullish, bearish };
}

const PENALTY_HEBREW: Record<string, string> = {
  extended: "המחיר מתוח הרחק מעל הרצועה / RSI מעל 80 – סיכון לרדיפה אחרי מחיר",
  volatility: "תנודתיות גבוהה (ATR) – תנודות יומיות חדות עלולות להפעיל את נקודת הביטול",
  counterTrend: "המניה מתחת לממוצע 200 – המגמה ארוכת הטווח אינה תומכת",
  shortHistory: "אין מספיק היסטוריה לממוצע 200 – המגמה ארוכת הטווח לא ידועה",
  wideStop: "נקודת הביטול רחוקה מהטריגר – הפסד פוטנציאלי גדול יחסית",
  riskReward: "יחס סיכוי/סיכון נמוך – הפוטנציאל הטכני קטן יחסית לסיכון עד נקודת הביטול",
  noTarget: "אין יעד טכני מעל הטריגר – לא ניתן למדוד פוטנציאל עלייה",
};

export function risksHebrew(
  penalties: ScorePenalty[],
  research: CompanyResearch,
  newsRisk: NewsRiskAssessment | null,
  daysToEarnings: number | null,
  fearGreed: FearGreed | null
): string[] {
  const out = penalties.map((p) => PENALTY_HEBREW[p.key] ?? p.note);
  if (daysToEarnings !== null && daysToEarnings >= 0 && daysToEarnings <= 14) {
    out.push(`דוח רבעוני צפוי ב-${research.nextEarningsDate} (בעוד ${daysToEarnings} ימים) – אירוע בינארי שעלול לשבור כל סטאפ טכני`);
  }
  for (const n of newsRisk?.negativeHeadlines.slice(0, 2) ?? []) out.push(`כותרת שלילית אחרונה: "${n.title}" (${n.source})`);
  if (research.newsSource.source === "unavailable") out.push("לא ניתן היה לאמת חדשות אחרונות – סיכון חדשותי לא נבדק במלואו");
  if (fearGreed && fearGreed.score <= 25) out.push(`סנטימנט שוק בפחד קיצוני (${fearGreed.score}) – פריצות נכשלות לעיתים קרובות יותר`);
  out.push("אותות טכניים נכשלים לעיתים קרובות; היעדים הם רמות ייחוס בלבד.");
  return out;
}

export function catalystsHebrew(research: CompanyResearch, daysToEarnings: number | null): string[] {
  const out: string[] = [];
  if (research.nextEarningsDate) {
    const timing = research.nextEarningsTiming === "pre-market" ? " (לפני הפתיחה)" : research.nextEarningsTiming === "post-market" ? " (אחרי הסגירה)" : "";
    out.push(`דוח רבעוני: ${research.nextEarningsDate}${timing}${daysToEarnings !== null ? ` – בעוד ${daysToEarnings} ימים` : ""}`);
  }
  const material = research.news.find((n) => materiality(n).weight > 0);
  if (material) out.push(`התפתחות אחרונה (${MATERIALITY_HEBREW[materiality(material).category]}): ${material.title}`);
  if (out.length === 0) out.push("לא אותר קטליזטור מתוזמן בחלון של 14 הימים הקרובים (לפי הנתונים הזמינים).");
  return out;
}
