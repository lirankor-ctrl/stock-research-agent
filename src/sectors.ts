import { CompanyProfile } from "./types";

// Known Nasdaq-style growth/tech tickers for fast-path classification
// before we even have profile data.
export const KNOWN_TECH_GROWTH_TICKERS = new Set([
  // Mega-cap tech
  "AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "META", "AMZN", "TSLA",
  // Semis
  "AMD", "AVGO", "INTC", "QCOM", "MU", "ASML", "TSM", "ARM", "SMCI",
  "MRVL", "LRCX", "AMAT", "KLAC", "ON", "MCHP",
  // Software / cloud
  "ADBE", "CRM", "ORCL", "NOW", "INTU", "SHOP", "SNOW", "MDB", "NET",
  "DDOG", "ZS", "PANW", "CRWD", "FTNT", "S", "OKTA", "TEAM", "TWLO",
  // AI / data
  "PLTR", "AI", "PATH", "SOUN", "BBAI",
  // Internet / consumer tech
  "NFLX", "ROKU", "PINS", "SNAP", "SPOT", "UBER", "ABNB", "DASH",
  "RBLX", "U", "EA", "TTWO",
  // Fintech / crypto-adjacent
  "COIN", "HOOD", "SOFI", "AFRM", "PYPL", "SQ",
  // Mining/crypto/AI hardware adjacent
  "MARA", "RIOT", "CLSK",
]);

const TECH_SECTOR_KEYWORDS = [
  "technology", "information technology", "communication services",
];

const TECH_INDUSTRY_KEYWORDS = [
  "software", "semiconductor", "internet", "cloud", "saas",
  "cyber", "security", "artificial intelligence", "ai",
  "computer hardware", "electronics", "data", "analytics",
  "biotech", "fintech", "telecom",
];

export interface SectorClassification {
  isTechGrowth: boolean;
  category: string; // human-readable bucket
}

export function classifyByTicker(ticker: string): boolean {
  return KNOWN_TECH_GROWTH_TICKERS.has(ticker.toUpperCase());
}

export function classifyProfile(
  profile: CompanyProfile | undefined,
  ticker: string
): SectorClassification {
  if (classifyByTicker(ticker)) {
    return { isTechGrowth: true, category: "Tech / Growth (known)" };
  }
  if (!profile) {
    return { isTechGrowth: false, category: "Unknown" };
  }

  const sector = (profile.sector ?? "").toLowerCase();
  const industry = (profile.industry ?? "").toLowerCase();

  const sectorHit = TECH_SECTOR_KEYWORDS.some((k) => sector.includes(k));
  const industryHit = TECH_INDUSTRY_KEYWORDS.some((k) => industry.includes(k));

  if (sectorHit || industryHit) {
    return {
      isTechGrowth: true,
      category: profile.industry || profile.sector || "Tech / Growth",
    };
  }

  return {
    isTechGrowth: false,
    category: profile.sector || "Other",
  };
}
