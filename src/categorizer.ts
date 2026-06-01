import { EnrichedStock, OpportunityTier } from "./types";

// Assign a single stock to a long-term bucket based on size, stability and
// earnings quality. This is independent of how many we ultimately show.
export function classifyTier(s: EnrichedStock): OpportunityTier {
  const cap = s.profile?.marketCap ?? 0;
  const eps = s.profile?.eps;
  const abs = Math.abs(s.changePercent);
  const profitable = (eps ?? 0) > 0 || (s.profile?.profitMargin ?? 0) > 0;

  // Core: large, stable, profitable.
  if (cap >= 50_000_000_000 && profitable && abs <= 20) return "core";

  // Growth: mid/large companies still compounding (incl. large-caps that are
  // a bit more volatile or not yet consistently profitable).
  if (cap >= 2_000_000_000) return "growth";

  // Anything that squeaked through the filter but is small / unprofitable /
  // volatile is, at best, a speculative idea.
  return "speculative";
}

export interface Categorized {
  core: EnrichedStock[];
  growth: EnrichedStock[];
  speculative: EnrichedStock[]; // max 1
}

const MAX_CORE = 4;
const MAX_GROWTH = 4;

// Build the three report categories from the scored, filtered universe.
export function categorize(stocks: EnrichedStock[]): Categorized {
  const sorted = [...stocks].sort((a, b) => b.finalScore - a.finalScore);

  const core: EnrichedStock[] = [];
  const growth: EnrichedStock[] = [];
  const specCandidates: EnrichedStock[] = [];

  for (const s of sorted) {
    if (s.tier === "core" && core.length < MAX_CORE) core.push(s);
    else if (s.tier === "growth" && growth.length < MAX_GROWTH) growth.push(s);
    else if (s.tier === "speculative") specCandidates.push(s);
    else if (s.tier === "core") growth.push(s); // overflow core -> growth
  }

  // Exactly one speculative idea, the highest-scoring candidate (if any).
  const speculative = specCandidates.slice(0, 1);

  return { core, growth, speculative };
}
