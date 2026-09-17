// ===== Provider outcome ledger =====
//
// The run-level "Unavailable: N" tally used to be computed from SourceInfo
// alone, which has only three values (live/cached/unavailable). That made a
// never-attempted call (skipped because the Alpha Vantage live-call budget was
// already spent) indistinguishable from a rate limit, from a network error,
// and from data that genuinely does not exist. "32 Unavailable" was therefore
// a number nobody could act on.
//
// This records the CAUSE at the exact point each cause is known, so Report
// Health can attribute every unavailable field instead of guessing from
// free-text notes after the fact.

export type UnavailableCause =
  | "rateLimit"        // provider explicitly rate-limited us
  | "missingApiKey"    // provider not configured – nothing was attempted
  | "budgetSkipped"    // live-call budget already spent; call deliberately skipped
  | "networkError"     // request failed (timeout, DNS, 5xx, parse)
  | "genuinelyAbsent"; // provider answered successfully and has no such data

export type ProviderName = "alphaVantage" | "finnhub" | "yahoo" | "nasdaq" | "cnn" | "other";

export interface ProviderFailure {
  provider: ProviderName;
  cause: UnavailableCause;
  key: string;
}

const failures: ProviderFailure[] = [];

// Cache keys are of the form "<kind>_<symbol>" (or bare, e.g. "movers").
// The kind is what identifies the provider, not the symbol.
export function providerForCacheKey(key: string): ProviderName {
  if (key.startsWith("yahoo_")) return "yahoo";
  if (key.startsWith("nasdaq_")) return "nasdaq";
  if (key.startsWith("finnhub_")) return "finnhub";
  if (
    key === "movers" ||
    key.startsWith("overview_") ||
    key.startsWith("quote_") ||
    key.startsWith("news_") ||
    key.startsWith("econ_")
  ) {
    return "alphaVantage";
  }
  return "other";
}

export function recordProviderFailure(provider: ProviderName, cause: UnavailableCause, key: string): void {
  failures.push({ provider, cause, key });
}

export function providerFailures(): ProviderFailure[] {
  return [...failures];
}

export function resetProviderLedger(): void {
  failures.length = 0;
}

// Counts by cause, then by provider – both are needed: "which provider is
// hurting us" and "why" are different questions.
export interface ProviderFailureBreakdown {
  byCause: Record<string, number>;
  byProvider: Record<string, number>;
  total: number;
}

export function summarizeProviderFailures(list: ProviderFailure[] = failures): ProviderFailureBreakdown {
  const byCause: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  for (const f of list) {
    byCause[f.cause] = (byCause[f.cause] ?? 0) + 1;
    byProvider[f.provider] = (byProvider[f.provider] ?? 0) + 1;
  }
  return { byCause, byProvider, total: list.length };
}
