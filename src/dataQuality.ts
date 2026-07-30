import {
  DataQuality,
  DataQualityLabel,
  DataQualityStatuses,
  DimensionStatus,
  EnrichedStock,
  SourceInfo,
} from "./types";

// Confidence weight of each data dimension (sums to 100 when ALL are assessable).
const WEIGHTS = {
  price: 30, // critical
  profile: 20,
  marketCap: 20,
  volume: 15,
  news: 10,
  technical: 5,
};

type Dim = keyof DataQualityStatuses;
export const DIMS: Dim[] = ["price", "volume", "marketCap", "profile", "news", "technical"];

// A stock is recommendable only when its quality clears this label.
const RECOMMEND_LABELS: ReadonlySet<DataQualityLabel> = new Set<DataQualityLabel>([
  "High",
  "Medium",
]);

// Hebrew label for each dimension – used for both "missing" and "rate limit" lists.
const DIM_HEBREW: Record<Dim, string> = {
  price: "מחיר עדכני",
  volume: "נתוני מחזור",
  marketCap: "שווי שוק",
  profile: "פרופיל חברה",
  news: "חדשות עדכניות",
  technical: "נתונים טכניים (Bollinger/RSI)",
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function hasProfileIdentity(s: EnrichedStock): boolean {
  const p = s.profile;
  return !!(p && (p.name || p.sector || p.industry));
}

// Classify a single dimension using (a) whether we actually have a usable
// value and (b) the SourceInfo that produced it (or its absence).
//
//   hasValue=true,  source=live      -> "available"
//   hasValue=true,  source=cached    -> "cached"        (counts same as available for coverage)
//   hasValue=false, source=undefined -> "notRequested"   (never attempted)
//   hasValue=false, source=unavailable -> "rateLimited"  (attempted, nothing usable)
//   hasValue=false, source=live/cached -> "genuinelyMissing" (we reached the
//                                          source and it confirmed absence)
function classifyDimension(hasValue: boolean, source: SourceInfo | undefined): DimensionStatus {
  if (hasValue) {
    return source?.source === "live" ? "available" : "cached";
  }
  if (!source) return "notRequested";
  if (source.source === "unavailable") return "rateLimited";
  return "genuinelyMissing";
}

// Classify every dimension. `technicalStatus` is decided by the pipeline (did
// the local Bollinger/RSI computation succeed, fail, get rate-limited, or was
// it never attempted?).
function computeStatuses(
  s: EnrichedStock,
  technicalStatus: DimensionStatus
): DataQualityStatuses {
  return {
    price: classifyDimension(s.price > 0, s.quoteSource),
    volume: classifyDimension(s.volume > 0, s.quoteSource),
    profile: classifyDimension(hasProfileIdentity(s), s.profileSource),
    marketCap: classifyDimension(
      !!(s.profile?.marketCap && s.profile.marketCap > 0),
      s.profileSource
    ),
    news: classifyDimension(s.news.length > 0, s.newsSource),
    technical: technicalStatus,
  };
}

function reliabilityHebrew(
  label: DataQualityLabel,
  missing: string[],
  rateLimited: string[],
  priceUnusable: boolean,
  confidenceScore: number
): string {
  const rlNote =
    rateLimited.length > 0
      ? ` נתונים שלא נשלפו עקב מגבלת API/לא נתבקשו (אינם פוגעים בכיסוי): ${rateLimited.join(", ")}.`
      : "";
  const confNote = ` רמת ביטחון (טריות + שלמות): ${confidenceScore}/100.`;

  if (label === "Excluded" && priceUnusable) {
    return (
      `הוחרגה – אין מחיר עדכני או שמור במטמון עבור המניה, ולכן לא ניתן לדרג או להמליץ עליה ` +
      `(ללא קשר לסיבה – חוסר נתון אמיתי או מגבלת API).${rlNote}`
    );
  }

  switch (label) {
    case "High":
      return `כיסוי נתונים גבוה – כל הנתונים שנאספו זמינים ומלאים.${confNote}${rlNote}`;
    case "Medium":
      return `כיסוי נתונים בינוני – חלק מהנתונים חסרים באמת (${missing.join(", ")}); מומלץ לאמת לפני פעולה.${confNote}${rlNote}`;
    case "Low":
      return `כיסוי נתונים נמוך – חסרים נתונים מהותיים באמת (${missing.join(", ")}); האות אינדיקטיבי בלבד.${confNote}${rlNote}`;
    case "Excluded":
      return `הוחרגה – נתונים קריטיים חסרים באמת (${missing.join(", ")}); לא ניתן לדרג או להמליץ על המניה.${rlNote}`;
  }
}

// Compute the data-quality verdict for a single stock.
//
// Coverage score reflects only how much data was retrieved:
//  - "rateLimited" / "notRequested" dimensions are excluded from BOTH the
//    numerator and denominator entirely (not a quality issue).
//  - "genuinelyMissing" dimensions count in the denominator but earn nothing
//    (a real quality issue).
//  - "available" / "cached" dimensions earn their full weight – a cached
//    value is just as usable as a live one for COVERAGE purposes.
//
// Confidence score starts from coverage and is then reduced by (a) cache
// staleness on any dimension that isn't live, and (b) a flat penalty when
// optional technical data isn't available – technical never excludes a
// stock, but its absence must always keep confidence below a perfect 100.
//
// Critical rule: a stock with NO usable price (live or cached) is ALWAYS
// excluded, regardless of whether that's because the price is genuinely
// missing or because the quote call was rate-limited. Price is not just
// another weighted dimension – without it the stock cannot be displayed,
// ranked, or recommended at all.
export function computeDataQuality(
  s: EnrichedStock,
  technicalStatus: DimensionStatus
): DataQuality {
  const statuses = computeStatuses(s, technicalStatus);

  const priceUsable = statuses.price === "available" || statuses.price === "cached";

  let assessable = 0;
  let earned = 0;
  for (const d of DIMS) {
    const st = statuses[d];
    if (st === "rateLimited" || st === "notRequested") continue; // not a coverage issue
    assessable += WEIGHTS[d];
    if (st === "available" || st === "cached") earned += WEIGHTS[d];
  }
  // Without a usable price, no other dimension can carry the score to 100 –
  // the score itself must reflect the exclusion, not just the label.
  const coverageScore = !priceUsable ? 0 : assessable > 0 ? Math.round((earned / assessable) * 100) : 0;

  // Freshness penalty: average staleness across every CACHED (non-live) dim
  // that has a real value, capped so it can't alone zero out confidence.
  const dimSource: Partial<Record<Dim, SourceInfo | undefined>> = {
    price: s.quoteSource,
    volume: s.quoteSource,
    profile: s.profileSource,
    marketCap: s.profileSource,
    news: s.newsSource,
  };
  const cachedAges: number[] = [];
  for (const d of ["price", "volume", "profile", "marketCap", "news"] as Dim[]) {
    if (statuses[d] === "cached") {
      cachedAges.push(dimSource[d]?.ageHours ?? 12);
    }
  }
  const avgAge = cachedAges.length > 0 ? cachedAges.reduce((a, b) => a + b, 0) / cachedAges.length : 0;
  const freshnessPenalty = cachedAges.length > 0 ? clamp(avgAge * 1.5, 5, 30) : 0;
  // Optional technical data is never a reason to exclude a stock, but its
  // absence must always keep confidence below a perfect score.
  const technicalGapPenalty = statuses.technical === "available" ? 0 : 15;
  const confidenceScore = clamp(coverageScore - freshnessPenalty - technicalGapPenalty, 0, 100);

  const missing = DIMS.filter((d) => statuses[d] === "genuinelyMissing").map((d) => DIM_HEBREW[d]);
  const rateLimited = DIMS.filter(
    (d) => statuses[d] === "rateLimited" || statuses[d] === "notRequested"
  ).map((d) => DIM_HEBREW[d]);

  const criticalGenuineMissing = (["price", "volume", "marketCap", "profile"] as Dim[]).filter(
    (d) => statuses[d] === "genuinelyMissing"
  ).length;

  const excluded =
    assessable === 0 || // nothing usable at all
    !priceUsable ||      // no usable price, live or cached – can't rank it, full stop
    criticalGenuineMissing >= 3; // too much genuinely missing

  let label: DataQualityLabel;
  if (excluded) label = "Excluded";
  else if (coverageScore >= 80) label = "High";
  else if (coverageScore >= 60) label = "Medium";
  else label = "Low";

  return {
    statuses,
    coverageScore,
    confidenceScore,
    label,
    excluded,
    missing,
    rateLimited,
    reliabilityHebrew: reliabilityHebrew(label, missing, rateLimited, !priceUsable, confidenceScore),
  };
}

// A stock may be ranked / recommended only when its quality clears the threshold.
export function meetsRecommendationThreshold(dq: DataQuality | undefined): boolean {
  return !!dq && !dq.excluded && RECOMMEND_LABELS.has(dq.label);
}

// One-line debug summary of which dimensions fed the score – printed per
// watchlist stock during a run so scoring mistakes are visible immediately.
export function dataQualityDebugSummary(dq: DataQuality): string {
  return DIMS.map((d) => `${d}=${dq.statuses[d]}`).join(" ");
}
