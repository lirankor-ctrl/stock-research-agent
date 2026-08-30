import { isExcludedSecurity, MIN_PRICE_USD } from "./filters";
import { meetsRecommendationThreshold } from "./dataQuality";
import { CompanyProfile, EnrichedStock } from "./types";

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

// How many of the market-cap / P/E / EPS / profit-margin fields are actually
// populated – used for confidence/diagnostics, never as a hard elimination
// gate (see meetsNormalTopOpportunityBar below). P/E, EPS and profit margin
// in particular are OPTIONAL enrichment from Alpha Vantage's OVERVIEW call:
// on a rate-limited run they're frequently the fields missing even when
// price/volume/profile identity/news/technicals are all live. Root cause of
// the 2026-08-28 "Top Opportunities: none" incident with 17 qualified
// candidates: this count used to be a HARD gate (>=2 required or the stock
// was dropped to Emergency Mode), so a single Alpha Vantage rate-limit hit
// on OVERVIEW could zero out every candidate at once even though nothing
// about the candidates themselves was actually weak.
function countMeaningfulFundamentals(profile: CompanyProfile | undefined): number {
  if (!profile) return 0;
  let n = 0;
  if (profile.marketCap && profile.marketCap > 0) n++;
  if (profile.peRatio && profile.peRatio > 0) n++;
  if (profile.eps !== undefined) n++;
  if (profile.profitMargin !== undefined) n++;
  return n;
}

// The bar for a NORMAL Top Opportunity. Mandatory data only:
//  - dataQuality already clears the recommendation threshold (not Excluded,
//    label High/Medium) – this covers price/volume/marketCap/profile/news/
//    technical coverage as a whole, see dataQuality.ts.
//  - basic company identity (a name) is resolvable.
// Optional enrichment (news, P/E, margin, extra profile detail) is NOT a
// gate here – missing optional data already lowers dataQuality's
// confidenceScore (see the fundamentals-depth penalty in dataQuality.ts) and
// is fully visible in the reliability line, but it must never by itself zero
// out an otherwise strong, liquid, well-covered stock's Top Opportunity
// eligibility. A candidate that genuinely fails the mandatory bar can still
// be shown, but only in the separate Reduced-Confidence Watch – never as a
// normal pick.
export function meetsNormalTopOpportunityBar(stock: EnrichedStock): boolean {
  if (!meetsRecommendationThreshold(stock.dataQuality)) return false;
  if (!stock.profile?.name) return false; // basic company identity
  return true;
}

// Human-readable reason a candidate did NOT make Top Opportunities – used to
// print rejection reasons for the top-ranked candidates in diagnostics (see
// pipeline.ts), so "Top Opportunities: none" is never a silent mystery.
export function explainTopOpportunityRejection(stock: EnrichedStock): string {
  const dq = stock.dataQuality;
  if (!dq) return "no data-quality score computed";
  if (dq.excluded) return `excluded – ${dq.reliabilityHebrew}`;
  if (!meetsRecommendationThreshold(dq)) {
    return `data quality label "${dq.label}" below Medium (coverage=${dq.coverageScore}, confidence=${dq.confidenceScore})`;
  }
  if (!stock.profile?.name) return "no resolvable company name/identity";
  const fundamentals = countMeaningfulFundamentals(stock.profile);
  return (
    `passes mandatory bar (label=${dq.label}, coverage=${dq.coverageScore}, confidence=${dq.confidenceScore}, ` +
    `fundamentals=${fundamentals}/4) – not selected, ranked below the cutoff`
  );
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
  // 0-limit normal-quality picks. Allowed to be fewer than `limit` – one
  // strong idea beats padding the list with weak ones. NEVER contains an
  // emergency-promoted stock.
  topOpportunities: EnrichedStock[];
  // 0-limit reduced-confidence candidates, populated ONLY when
  // topOpportunities came back empty. Rendered in their own
  // "⚠️ Reduced-Confidence Watch" block, never merged into Top Opportunities.
  emergencyWatch: EnrichedStock[];
  emergencyModeActive: boolean; // true iff emergencyWatch is non-empty
}

// Single entry point pipeline.ts (and the self-test) use to decide Top
// Opportunities: normal-quality candidates first (see
// meetsNormalTopOpportunityBar); only when that yields NOTHING does
// Emergency Mode engage, filling the separate Reduced-Confidence Watch list
// instead – never the normal one. When adequate coverage returns,
// `normal` is non-empty again and Emergency Mode is bypassed automatically –
// there is no separate "mode" flag to remember or reset.
export function buildTopOpportunities(
  rankedCandidates: EnrichedStock[],
  limit = 3
): TopOpportunitiesResult {
  const normal = rankedCandidates.filter(meetsNormalTopOpportunityBar).slice(0, limit);
  if (normal.length > 0) {
    return { topOpportunities: normal, emergencyWatch: [], emergencyModeActive: false };
  }

  const emergency = selectEmergencyCandidates(rankedCandidates, limit);
  return { topOpportunities: [], emergencyWatch: emergency, emergencyModeActive: emergency.length > 0 };
}
