import { runReport } from "./pipeline";
import { SourceInfo } from "./types";

function describeSource(s: SourceInfo): string {
  if (s.source === "live") return "live";
  if (s.source === "cached") return `cached (${s.ageHours ?? "?"}h old)`;
  return "unavailable";
}

async function main() {
  const result = await runReport();

  if (result.enrichedTop.length > 0) {
    console.log("\n🏆 Top opportunities:");
    for (const s of result.enrichedTop) {
      console.log(
        `  ${s.ticker.padEnd(6)} score=${s.finalScore.toFixed(1)}/10  ` +
          `profile=${describeSource(s.profileSource)} news=${describeSource(s.newsSource)}`
      );
    }
  }
}

main().catch((err) => {
  console.error("💥 Fatal error:", err.message ?? err);
  process.exit(1);
});
