import "dotenv/config";
import { getTopMovers } from "./dataSources";
import {
  buildSkeletonEnriched,
  DEFAULT_ENRICH_TOP_N,
  enrichStocks,
} from "./enricher";
import {
  generateHtmlReport,
  writeHtmlReport,
} from "./htmlReportGenerator";
import { preRank } from "./ranker";
import { generateReport, writeReport } from "./reportGenerator";
import { EnrichedStock, RunStatus, SourceInfo } from "./types";

const TOP_N = Number(process.env.STOCK_AGENT_ENRICH_TOP ?? DEFAULT_ENRICH_TOP_N);
const ENRICH_DELAY_MS = Number(process.env.STOCK_AGENT_DELAY_MS ?? 13_000);

export interface ReportResult {
  mdPath: string;
  htmlPath: string;
  status: RunStatus;
  enrichedTop: EnrichedStock[];
  skeletonRest: EnrichedStock[];
  rawCounts: { gainers: number; losers: number; active: number };
  hasData: boolean;
}

export interface RunOptions {
  log?: (msg: string) => void;
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
  if (live > 0 && cached > 0) return { source: "live" };
  if (unavailable > 0) return { source: "unavailable" };
  return { source: "live" };
}

export async function runReport(opts: RunOptions = {}): Promise<ReportResult> {
  const log = opts.log ?? console.log.bind(console);

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey || apiKey === "your_free_api_key_here") {
    throw new Error(
      "Missing ALPHA_VANTAGE_API_KEY in .env. Get a free key at: https://www.alphavantage.co/support/#api-key"
    );
  }

  const status: RunStatus = {
    movers: { source: "unavailable" },
    enriched: { source: "unavailable" },
    rateLimitHit: false,
    notes: [],
    liveCount: 0,
    cachedCount: 0,
    missingCount: 0,
  };

  const tallyStatus = (src: SourceInfo) => {
    if (src.source === "live") status.liveCount++;
    else if (src.source === "cached") status.cachedCount++;
    else status.missingCount++;
  };

  // ===== Phase 1: Movers =====
  log("📡 [1/4] Loading market movers (cache-first, 12h TTL)...");
  const moversRes = await getTopMovers(apiKey, (m) => {
    log(`   ${m}`);
    if (m.toLowerCase().includes("rate limit")) status.rateLimitHit = true;
    status.notes.push(m);
  });
  status.movers = moversRes.source;
  tallyStatus(moversRes.source);
  log(`   source: ${describeSource(moversRes.source)}`);

  if (!moversRes.value) {
    log("⚠️  No movers data available (no live API + no cache). Writing empty report.");
    const empty = { gainers: 0, losers: 0, active: 0 };
    const mdPath = writeReport(generateReport([], [], empty, status));
    const htmlPath = writeHtmlReport(generateHtmlReport([], [], empty, status));
    return {
      mdPath,
      htmlPath,
      status,
      enrichedTop: [],
      skeletonRest: [],
      rawCounts: empty,
      hasData: false,
    };
  }

  // ===== Phase 2: Filter =====
  log("🧹 [2/4] Filtering penny / OTC / sub-$5 names...");
  const ranked = preRank(moversRes.value);
  log(
    `   raw: ${ranked.rawCounts.gainers} gainers, ${ranked.rawCounts.losers} losers, ${ranked.rawCounts.active} active`
  );
  log(`   after filter & dedup: ${ranked.all.length} candidates`);

  // ===== Phase 3: Enrich top N =====
  const enrichN = Math.min(TOP_N, ranked.all.length);
  log(
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
          log(m);
          if (m.toLowerCase().includes("rate limit")) status.rateLimitHit = true;
        },
      });
      enrichedTop = res.stocks;
      liveCalls = res.liveCalls;
      cachedCalls = res.cachedCalls;
      unavailableCalls = res.unavailableCalls;
      status.liveCount += liveCalls;
      status.cachedCount += cachedCalls;
      status.missingCount += unavailableCalls;
    } catch (err: any) {
      log(`⚠️  enrichment failed: ${err.message} – continuing with skeleton data`);
      status.notes.push(`enrichment failed: ${err.message}`);
    }
  }

  status.enriched = resolveEnrichmentSource(
    liveCalls,
    cachedCalls,
    unavailableCalls,
    enrichedTop.length === 0
  );
  log(
    `   enrichment summary: live=${liveCalls}, cached=${cachedCalls}, unavailable=${unavailableCalls}`
  );

  const enrichedTickers = new Set(enrichedTop.map((s) => s.ticker));
  const skeletonRest = ranked.all
    .filter((s) => !enrichedTickers.has(s.ticker))
    .map(buildSkeletonEnriched);

  // ===== Phase 4: Report =====
  log("📝 [4/4] Generating Hebrew reports (Markdown + HTML)...");
  const mdReport = generateReport(enrichedTop, skeletonRest, ranked.rawCounts, status);
  const htmlReport = generateHtmlReport(enrichedTop, skeletonRest, ranked.rawCounts, status);
  const mdPath = writeReport(mdReport);
  const htmlPath = writeHtmlReport(htmlReport);
  log(`✅ Markdown report: ${mdPath}`);
  log(`✅ HTML report:     ${htmlPath}`);

  return {
    mdPath,
    htmlPath,
    status,
    enrichedTop,
    skeletonRest,
    rawCounts: ranked.rawCounts,
    hasData: true,
  };
}
