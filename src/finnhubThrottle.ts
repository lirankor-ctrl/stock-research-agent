// Finnhub's free tier allows 60 API calls per minute, shared across every
// endpoint. Since company fundamentals moved off Alpha Vantage's OVERVIEW and
// onto Finnhub (see dataSources.ts's getOverview), a cold-cache run makes up
// to three Finnhub calls per stock — profile2, metric, company-news — on top
// of the earnings calendar and earnings-result calls. Across a full universe
// that comfortably exceeds 60 in the first minute, and unlike Alpha Vantage
// there is no daily budget guard in front of it.
//
// A single shared minimum spacing between ALL Finnhub requests keeps the run
// under the limit without needing per-endpoint accounting. 1100ms yields ~54
// calls/minute, leaving headroom for clock jitter and retries.
const MIN_SPACING_MS = Number(process.env.FINNHUB_MIN_SPACING_MS ?? 1100);

// Serialized through a promise chain rather than a timestamp check, so
// concurrent callers queue behind each other instead of all reading the same
// "last call" time and firing together.
let queue: Promise<void> = Promise.resolve();

export function throttleFinnhub<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn);
  // The gate advances regardless of whether fn resolved or rejected — a failed
  // call still consumed a request against the quota.
  queue = result.then(
    () => new Promise((resolve) => setTimeout(resolve, MIN_SPACING_MS)),
    () => new Promise((resolve) => setTimeout(resolve, MIN_SPACING_MS))
  );
  return result;
}
