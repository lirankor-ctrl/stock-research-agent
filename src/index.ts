import { runReport } from "./pipeline";
import { SourceInfo } from "./types";

function describeSource(s: SourceInfo): string {
  if (s.source === "live") return "live";
  if (s.source === "cached") return `cached (${s.ageHours ?? "?"}h old)`;
  return "unavailable";
}

async function main() {
  const result = await runReport();

  const summarize = (label: string, stocks: typeof result.core) => {
    if (stocks.length === 0) return;
    console.log(`\n${label}:`);
    for (const s of stocks) {
      console.log(
        `  ${s.ticker.padEnd(6)} score=${s.finalScore.toFixed(1)}/10  ` +
          `profile=${describeSource(s.profileSource)} news=${describeSource(s.newsSource)}`
      );
    }
  };

  summarize("🏛️  Core", result.core);
  summarize("🌱  Growth", result.growth);
  summarize("🎲  Speculative", result.speculative);
}

main().catch((err) => {
  console.error("💥 Fatal error:", err.message ?? err);
  process.exit(1);
});
