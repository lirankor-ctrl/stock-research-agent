import "dotenv/config";
import { fetchTopMovers } from "./alphaVantage";
import { enrichStocks } from "./enricher";
import { preRank } from "./ranker";
import { generateReport, writeReport } from "./reportGenerator";

const MAX_ENRICH = Number(process.env.STOCK_AGENT_MAX_ENRICH ?? 10);
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

  console.log("📡 [1/4] Fetching US market movers...");
  const data = await fetchTopMovers(apiKey);

  console.log("🧹 [2/4] Filtering penny / OTC / sub-$5 names...");
  const ranked = preRank(data);
  console.log(
    `   raw: ${ranked.rawCounts.gainers} gainers, ${ranked.rawCounts.losers} losers, ${ranked.rawCounts.active} active`
  );
  console.log(`   after filter & dedup: ${ranked.all.length} candidates`);

  if (ranked.all.length === 0) {
    console.error("⚠️  No candidates survived filtering.");
    process.exit(1);
  }

  console.log(
    `🔬 [3/4] Enriching top ${Math.min(MAX_ENRICH, ranked.all.length)} candidates with company profile + news`
  );
  console.log(
    `   (rate-limited: ~${ENRICH_DELAY_MS / 1000}s between API calls – this will take a few minutes)`
  );

  const enriched = await enrichStocks(ranked.all, {
    apiKey,
    maxTickers: MAX_ENRICH,
    delayMs: ENRICH_DELAY_MS,
    onProgress: (m) => console.log(m),
  });

  if (enriched.length === 0) {
    console.error("⚠️  No enriched stocks passed final filtering.");
    process.exit(1);
  }

  console.log("\n🏆 Top picks (final scores):");
  for (const s of enriched) {
    const name = s.profile?.name ?? "";
    console.log(
      `  ${s.ticker.padEnd(6)} $${s.price.toFixed(2).padStart(8)}  ${s.changePercent.toFixed(2).padStart(7)}%  score=${s.finalScore.toFixed(1)}/10  ${name}`
    );
  }

  console.log("\n📝 [4/4] Generating Hebrew report...");
  const report = generateReport(enriched, ranked.rawCounts);
  const filePath = writeReport(report);
  console.log(`✅ Report written to: ${filePath}`);
}

main().catch((err) => {
  console.error("💥 Error:", err.message ?? err);
  process.exit(1);
});
