import { CompanyProfile, NewsItem, Stock } from "./types";

const POSITIVE_KEYWORDS = [
  "beat", "beats", "exceeds", "raises guidance", "record",
  "upgrade", "upgraded", "buy rating", "price target", "approval",
  "partnership", "deal", "wins", "launch", "growth", "surge",
  "all-time high", "earnings",
];

const NEGATIVE_KEYWORDS = [
  "miss", "missed", "downgrade", "downgraded", "cuts guidance",
  "lawsuit", "investigation", "probe", "recall", "warning",
  "layoffs", "drop", "plunge", "loss", "decline", "delay",
  "fraud", "bankruptcy",
];

function detectDrivers(news: NewsItem[]): { type: "positive" | "negative" | "mixed" | "none"; sample?: string } {
  if (!news || news.length === 0) return { type: "none" };

  let pos = 0;
  let neg = 0;
  let sample: string | undefined;

  for (const n of news.slice(0, 5)) {
    const title = (n.title ?? "").toLowerCase();
    const sScore = n.sentimentScore ?? 0;
    let matched = false;
    if (POSITIVE_KEYWORDS.some((k) => title.includes(k)) || sScore > 0.15) {
      pos++;
      matched = true;
    }
    if (NEGATIVE_KEYWORDS.some((k) => title.includes(k)) || sScore < -0.15) {
      neg++;
      matched = true;
    }
    if (matched && !sample) sample = n.title;
  }

  if (pos === 0 && neg === 0) return { type: "none", sample: news[0]?.title };
  if (pos > 0 && neg === 0) return { type: "positive", sample };
  if (neg > 0 && pos === 0) return { type: "negative", sample };
  return { type: "mixed", sample };
}

export function explainWhyHebrew(
  stock: Stock,
  profile: CompanyProfile | undefined,
  news: NewsItem[]
): string {
  const drivers = detectDrivers(news);
  const change = stock.changePercent;
  const direction = change >= 0 ? "עליה" : "ירידה";
  const absChange = Math.abs(change).toFixed(2);
  const volM = (stock.volume / 1_000_000).toFixed(1);

  const companyName = profile?.name ?? stock.ticker;
  const sectorLabel = profile?.industry || profile?.sector;
  const sectorText = sectorLabel ? ` (${sectorLabel})` : "";

  const headline = `${companyName}${sectorText} רשמה ${direction} של ${absChange}% במחזור של כ-${volM}M מניות.`;

  let driverText = "";
  switch (drivers.type) {
    case "positive":
      driverText = ` הסיבה ככל הנראה: חדשות חיוביות${drivers.sample ? ` – "${drivers.sample}"` : ""}.`;
      break;
    case "negative":
      driverText = ` הסיבה ככל הנראה: חדשות שליליות${drivers.sample ? ` – "${drivers.sample}"` : ""}.`;
      break;
    case "mixed":
      driverText = ` הרקע מעורב: גם חדשות חיוביות וגם שליליות${drivers.sample ? ` (לדוגמה: "${drivers.sample}")` : ""}.`;
      break;
    case "none":
      driverText = ` לא זוהו חדשות חזקות – ייתכן שמדובר בתנועה טכנית, מומנטום סקטוריאלי או זרימת כסף.`;
      break;
  }

  return headline + driverText;
}
