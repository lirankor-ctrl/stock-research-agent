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
const DIMS: Dim[] = ["price", "volume", "marketCap", "profile", "news", "technical"];

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

// We couldn't even reach the data when the source is missing/unavailable.
function unreachable(src?: SourceInfo): boolean {
  return !src || src.source === "unavailable";
}

function hasProfileIdentity(s: EnrichedStock): boolean {
  const p = s.profile;
  return !!(p && (p.name || p.sector || p.industry));
}

// Classify every dimension as available / genuinely missing / rate-limited.
// `technicalStatus` is decided by the pipeline (did the daily-closes fetch
// succeed, fail to compute, or get skipped by the budget?).
function computeStatuses(
  s: EnrichedStock,
  technicalStatus: DimensionStatus
): DataQualityStatuses {
  const profileUnreachable = s.profileSource.source === "unavailable";

  return {
    price: s.price > 0 ? "available" : unreachable(s.quoteSource) ? "rateLimited" : "missing",
    volume: s.volume > 0 ? "available" : unreachable(s.quoteSource) ? "rateLimited" : "missing",
    profile: hasProfileIdentity(s) ? "available" : profileUnreachable ? "rateLimited" : "missing",
    marketCap:
      s.profile?.marketCap && s.profile.marketCap > 0
        ? "available"
        : profileUnreachable
        ? "rateLimited"
        : "missing",
    news: s.news.length > 0 ? "available" : s.newsSource.source === "unavailable" ? "rateLimited" : "missing",
    technical: technicalStatus,
  };
}

function reliabilityHebrew(
  label: DataQualityLabel,
  missing: string[],
  rateLimited: string[]
): string {
  const rlNote =
    rateLimited.length > 0
      ? ` נתונים שלא נשלפו עקב מגבלת API (אינם פוגעים בציון): ${rateLimited.join(", ")}.`
      : "";

  switch (label) {
    case "High":
      return `אמינות גבוהה – כל הנתונים שנאספו זמינים ומלאים.${rlNote}`;
    case "Medium":
      return `אמינות בינונית – חלק מהנתונים חסרים באמת (${missing.join(", ")}); מומלץ לאמת לפני פעולה.${rlNote}`;
    case "Low":
      return `אמינות נמוכה – חסרים נתונים מהותיים באמת (${missing.join(", ")}); האות אינדיקטיבי בלבד.${rlNote}`;
    case "Excluded":
      return `הוחרגה – נתונים קריטיים חסרים באמת (${missing.join(", ")}); לא ניתן לדרג או להמליץ על המניה.${rlNote}`;
  }
}

// Compute the data-quality verdict for a single stock. The score reflects only
// the QUALITY of the data we could actually assess – dimensions that were
// rate-limited are removed from the calculation entirely (not penalized).
export function computeDataQuality(
  s: EnrichedStock,
  technicalStatus: DimensionStatus
): DataQuality {
  const statuses = computeStatuses(s, technicalStatus);

  // Score = earned / assessable, where rate-limited dims are excluded from both.
  let assessable = 0;
  let earned = 0;
  for (const d of DIMS) {
    if (statuses[d] === "rateLimited") continue; // not a quality issue
    assessable += WEIGHTS[d];
    if (statuses[d] === "available") earned += WEIGHTS[d];
  }
  const score = assessable > 0 ? Math.round((earned / assessable) * 100) : 0;

  const missing = DIMS.filter((d) => statuses[d] === "missing").map((d) => DIM_HEBREW[d]);
  const rateLimited = DIMS.filter((d) => statuses[d] === "rateLimited").map((d) => DIM_HEBREW[d]);

  // Exclusion is based ONLY on genuinely missing data, never on rate limits.
  const criticalGenuineMissing = (["price", "volume", "marketCap", "profile"] as Dim[]).filter(
    (d) => statuses[d] === "missing"
  ).length;
  const excluded =
    assessable === 0 || // nothing usable at all
    statuses.price === "missing" || // genuinely no price
    criticalGenuineMissing >= 3; // too much genuinely missing

  let label: DataQualityLabel;
  if (excluded) label = "Excluded";
  else if (score >= 80) label = "High";
  else if (score >= 60) label = "Medium";
  else label = "Low";

  return {
    statuses,
    score,
    label,
    excluded,
    missing,
    rateLimited,
    reliabilityHebrew: reliabilityHebrew(label, missing, rateLimited),
  };
}

// A stock may be ranked / recommended only when its quality clears the threshold.
export function meetsRecommendationThreshold(dq: DataQuality | undefined): boolean {
  return !!dq && !dq.excluded && RECOMMEND_LABELS.has(dq.label);
}
