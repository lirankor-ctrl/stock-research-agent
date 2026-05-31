import "dotenv/config";
import { getTopMovers } from "./dataSources";
import {
  buildSkeletonEnriched,
  DEFAULT_ENRICH_TOP_N,
  enrichStocks,
} from "./enricher";
import { preRank } from "./ranker";
import { generateReport, writeReport } from "./reportGenerator";
import { EnrichedStock, RunStatus, SourceInfo } from "./types";

const TOP_N = Number(process.env.STOCK_AGENT_ENRICH_TOP ?? DEFAULT_ENRICH_TOP_N);
const ENRICH_DELAY_MS = Number(process.env.STOCK_AGENT_DELAY_MS ?? 13_000);

async function main() {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey || apiKey === "your_free_api_key_here") {
    console.error(
      "❌ Missing ALPHA_VANTAGE_API_KEY in .env\n" +
        "   Get a free key at: https://www.alphavantage.co/support/#api-key"
    );
    process.exit(1);
  }

  const status: RunStatus = {
    movers: { source: "unavailable" },
    enriched: { source: "unavailable" },
    rateLimitHit: false,
    notes: [],
  };

  // ===== Phase 1: Market Movers (cache-first, 12h TTL) =====
  console.log("📡 [1/4] Loading market movers (cache-first, 12h TTL)...");
  const moversRes = await getTopMovers(apiKey, (m) => {
    console.log(`   ${m}`);
    if (m.toLowerCase().includes("rate limit")) status.rateLimitHit = true;
    status.notes.push(m);
  });
  status.movers = moversRes.source;
  console.log(`   source: ${describeSource(moversRes.source)}`);

  if (!moversRes.value) {
    console.error(
      "⚠️  No movers data available (no live API + no cache). Writing empty report."
    );
    const report = generateReport([], [], { gainers: 0, losers: 0, active: 0 }, status);
    const fp = writeReport(report);
    console.log(`📝 Empty report written to: ${fp}`);
    return;
  }

  // ===== Phase 2: Filter + pre-rank =====
  console.log("🧹 [2/4] Filtering penny / OTC / sub-$5 names...");
  const ranked = preRank(moversRes.value);
  console.log(
    `   raw: ${ranked.rawCounts.gainers} gainers, ${ranked.rawCounts.losers} losers, ${ranked.rawCounts.active} active`
  );
  console.log(`   after filter & dedup: ${ranked.all.length} candidates`);

  // ===== Phase 3: Enrich top N (default 3) =====
  const enrichN = Math.min(TOP_N, ranked.all.length);
  console.log(
    `🔬 [3/4] Enriching top ${enrichN} candidates (cache-first, 24h TTL)...`
  );

  let enrichedTop: EnrichedStock[] = [];
  let liveCalls = 0;
  let cachedCalls = 0;
  let unavailableCalls = 0;

  if (enrichN > 0) {
    try {
      const res = await enrichStocks(ranked.all, {
        apiKey,
        topN: enrichN,
        delayMs: ENRICH_DELAY_MS,
        onProgress: (m) => {
          console.log(m);
          if (m.toLowerCase().includes("rate limit")) status.rateLimitHit = true;
        },
      });
      enrichedTop = res.stocks;
      liveCalls = res.liveCalls;
      cachedCalls = res.cachedCalls;
      unavailableCalls = res.unavailableCalls;
    } catch (err: any) {
      console.error(
        `⚠️  enrichment failed entirely: ${err.message} – continuing with skeleton data`
      );
      status.notes.push(`enrichment failed: ${err.message}`);
    }
  }

  status.enriched = resolveEnrichmentSource(
    liveCalls,
    cachedCalls,
    unavailableCalls,
    enrichedTop.length === 0
  );
  console.log(
    `   enrichment summary: live=${liveCalls}, cached=${cachedCalls}, unavailable=${unavailableCalls}`
  );

  // The rest of the candidate list is rendered without API enrichment.
  // We mark them clearly as "unavailable" for profile/news.
  const enrichedTickers = new Set(enrichedTop.map((s) => s.ticker));
  const skeletonRest = ranked.all
    .filter((s) => !enrichedTickers.has(s.ticker))
    .map(buildSkeletonEnriched);

  // ===== Phase 4: Report =====
  console.log("📝 [4/4] Generating Hebrew report...");
  const report = generateReport(
    enrichedTop,
    skeletonRest,
    ranked.rawCounts,
    status
  );
  const fp = writeReport(report);
  console.log(`✅ Report written to: ${fp}`);

  console.log("\n🏆 Top opportunities:");
  for (const s of enrichedTop) {
    console.log(
      `  ${s.ticker.padEnd(6)} score=${s.finalScore.toFixed(1)}/10  ` +
        `profile=${describeSource(s.profileSource)} news=${describeSource(s.newsSource)}`
    );
  }
}

function describeSource(s: SourceInfo): string {
  if (s.source === "live") return "live";
  if (s.source === "cached") return `cached (${s.ageHours ?? "?"}h old)`;
  return "unavailable";
}

function resolveEnrichmentSource(
  live: number,
  cached: number,
  unavailable: number,
  noStocks: boolean
): SourceInfo {
  if (noStocks) return { source: "unavailable" };
  if (live > 0 && cached === 0) return { source: "live" };
  if (cached > 0 && live === 0) return { source: "cached" };
  if (live > 0 && cached > 0) return { source: "live" }; // partially fresh – call it live
  if (unavailable > 0) return { source: "unavailable" };
  return { source: "live" };
}

main().catch((err) => {
  console.error("💥 Fatal error:", err.message ?? err);
  process.exit(1);
});
