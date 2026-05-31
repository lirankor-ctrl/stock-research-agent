import { EnrichedStock } from "./types";

export interface MarketMood {
  tags: string[];        // short labels like "Risk-on", "AI momentum"
  summaryHebrew: string; // 2-3 sentence Hebrew summary
}

function isAi(s: EnrichedStock): boolean {
  const blob = `${s.profile?.industry ?? ""} ${s.profile?.sector ?? ""} ${s.profile?.name ?? ""}`.toLowerCase();
  return (
    blob.includes("artificial intelligence") ||
    blob.includes(" ai ") ||
    blob.includes("semiconductor")
  );
}

function isSoftware(s: EnrichedStock): boolean {
  const ind = (s.profile?.industry ?? "").toLowerCase();
  return ind.includes("software") || ind.includes("saas") || ind.includes("cloud");
}

function isBiotech(s: EnrichedStock): boolean {
  const ind = (s.profile?.industry ?? "").toLowerCase();
  const sec = (s.profile?.sector ?? "").toLowerCase();
  return ind.includes("biotech") || ind.includes("pharma") || sec.includes("health");
}

export function detectMarketMood(all: EnrichedStock[]): MarketMood {
  const tags: string[] = [];
  const gainers = all.filter((s) => s.changePercent > 0);
  const losers = all.filter((s) => s.changePercent < 0);

  const total = all.length || 1;
  const gainerShare = gainers.length / total;

  // Risk-on / Risk-off
  if (gainerShare >= 0.6) tags.push("Risk-on");
  else if (gainerShare <= 0.4) tags.push("Risk-off");
  else tags.push("Mixed");

  // Sector-specific signals (need enrichment data to detect)
  const aiGainers = gainers.filter(isAi).length;
  const aiLosers = losers.filter(isAi).length;
  if (aiGainers >= 2 && aiGainers > aiLosers) tags.push("AI momentum");

  const bioGainers = gainers.filter(isBiotech).length;
  if (bioGainers >= 2) tags.push("Biotech rally");

  const swLosers = losers.filter(isSoftware).length;
  const swGainers = gainers.filter(isSoftware).length;
  if (swLosers >= 2 && swLosers > swGainers) tags.push("Software weakness");

  const avgGainerMove =
    gainers.length > 0
      ? gainers.reduce((a, b) => a + b.changePercent, 0) / gainers.length
      : 0;
  const avgLoserMove =
    losers.length > 0
      ? losers.reduce((a, b) => a + b.changePercent, 0) / losers.length
      : 0;

  // Hebrew narrative
  const moodHe =
    gainerShare >= 0.6
      ? "האווירה היומית **חיובית (Risk-on)**"
      : gainerShare <= 0.4
        ? "האווירה היומית **שלילית (Risk-off)**"
        : "האווירה היומית **מעורבת**";

  const sectorNarrative: string[] = [];
  if (tags.includes("AI momentum")) {
    sectorNarrative.push("מומנטום בולט בענפי AI וסמיקונדקטור");
  }
  if (tags.includes("Biotech rally")) {
    sectorNarrative.push("חוזק יחסי בביוטכנולוגיה");
  }
  if (tags.includes("Software weakness")) {
    sectorNarrative.push("חולשה במניות תוכנה / SaaS");
  }

  const sectorText =
    sectorNarrative.length > 0 ? `, עם ${sectorNarrative.join(" וכן ")}` : "";

  const summaryHebrew = `${moodHe}${sectorText}. מבין המניות שדורגו: ${gainers.length} עולות (ממוצע ${avgGainerMove.toFixed(1)}%) מול ${losers.length} יורדות (ממוצע ${avgLoserMove.toFixed(1)}%).`;

  return { tags, summaryHebrew };
}
