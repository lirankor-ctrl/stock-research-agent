import { isExcludedSecurity, MIN_PRICE_USD } from "./filters";
import { meetsRecommendationThreshold } from "./dataQuality";
import { EnrichedStock } from "./types";

// Exact label required to appear on every Emergency-Mode-promoted stock, in
// every render surface (Markdown, HTML, email HTML, email text) – the
// self-test asserts on this literal string so it can never quietly
// disappear from an attachment.
export const EMERGENCY_MODE_LABEL = "Reduced Confidence / Emergency Mode";

// Shown once, at the section level, only when Emergency Mode actually
// activated – explains WHY, never silently.
export const EMERGENCY_MODE_EXPLANATION_HEBREW =
  "כיסוי הנתונים החיים היה מוגבל היום. ההזדמנויות הבאות מבוססות על הנתונים המאומתים הטובים ביותר שהיו זמינים, ומסומנות ‹Reduced Confidence / Emergency Mode›.";

// Narrow, high-confidence keyword set for a *confirmed* material negative
// fundamental event – deliberately stricter than explainer.ts's general
// NEGATIVE_KEYWORDS list (which also matches routine words like "miss" or
// "decline"). Matched only against real fetched headlines, never inferred
// from missing data. Emergency Mode must stay conservative: relaxing a
// coverage gap is fine, relaxing a solvency/fraud red flag is not.
const MATERIAL_NEGATIVE_EVENT_KEYWORDS = [
  "bankruptcy", "chapter 11", "insolvency", "insolvent",
  "going concern", "delisting", "delisted", "delist",
  "accounting fraud", "securities fraud", "restatement", "restating financials",
  "sec charges", "sec investigation", "doj investigation", "criminal probe",
  "ceases operations", "shuts down", "shutting down",
  "debt default", "default on its debt",
];

function hasConfirmedMaterialNegativeEvent(stock: EnrichedStock): boolean {
  return stock.news.some((n) => {
    const title = (n.title ?? "").toLowerCase();
    return MATERIAL_NEGATIVE_EVENT_KEYWORDS.some((k) => title.includes(k));
  });
}

export interface EmergencySafetyResult {
  ok: boolean;
  reason?: string;
}

// Re-derives every core safety rule from scratch, independent of the
// upstream dataQuality/tier computation. Emergency Mode is allowed to relax
// MISSING profile/news/technical coverage, but must never relax price,
// liquidity/OTC, or confirmed-bad-news safety – this is the one gate a
// candidate cannot buy its way past no matter how good its score looks.
export function passesEmergencySafetyFilter(stock: EnrichedStock): EmergencySafetyResult {
  if (!(stock.price > 0)) {
    return { ok: false, reason: "no current or cached price" };
  }
  if (stock.price < MIN_PRICE_USD) {
    return { ok: false, reason: "below minimum price threshold" };
  }
  if (isExcludedSecurity(stock.ticker)) {
    return { ok: false, reason: "penny / OTC / warrant / unit security" };
  }
  if (hasConfirmedMaterialNegativeEvent(stock)) {
    return { ok: false, reason: "confirmed material negative fundamental event" };
  }
  return { ok: true };
}

// Best-available candidates for Emergency Report Mode: ranked by score,
// safety-filtered from scratch, and explicitly tagged so no renderer can
// ever present one as a normal high-confidence Top Opportunity.
function selectEmergencyCandidates(
  candidates: EnrichedStock[],
  limit: number
): EnrichedStock[] {
  return candidates
    .filter((s) => passesEmergencySafetyFilter(s).ok)
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, limit)
    .map((s) => ({ ...s, emergencyMode: true }));
}

export interface TopOpportunitiesResult {
  stocks: EnrichedStock[];
  emergencyModeActive: boolean;
}

// Single entry point pipeline.ts (and the self-test) use to decide Top
// Opportunities: normal High/Medium-quality candidates first; only when
// that yields nothing does Emergency Mode engage, and only over candidates
// that pass the from-scratch safety filter above. When adequate coverage
// returns, `normal` is non-empty again and Emergency Mode is bypassed
// automatically – there is no separate "mode" flag to remember or reset.
export function buildTopOpportunities(
  rankedCandidates: EnrichedStock[],
  limit = 3
): TopOpportunitiesResult {
  const normal = rankedCandidates
    .filter((s) => meetsRecommendationThreshold(s.dataQuality))
    .slice(0, limit);
  if (normal.length > 0) {
    return { stocks: normal, emergencyModeActive: false };
  }

  const emergency = selectEmergencyCandidates(rankedCandidates, limit);
  return { stocks: emergency, emergencyModeActive: emergency.length > 0 };
}
