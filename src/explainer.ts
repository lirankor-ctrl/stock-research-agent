import { CompanyProfile, NewsItem, Stock } from "./types";
import { isNasdaq100, isSp500, watchlistName } from "./universe";

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

type Drivers = {
  type: "positive" | "negative" | "mixed" | "none";
  sample?: string;
  positiveCount: number;
  negativeCount: number;
};

function detectDrivers(news: NewsItem[]): Drivers {
  if (!news || news.length === 0) {
    return { type: "none", positiveCount: 0, negativeCount: 0 };
  }
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

  let type: Drivers["type"];
  if (pos === 0 && neg === 0) type = "none";
  else if (pos > 0 && neg === 0) type = "positive";
  else if (neg > 0 && pos === 0) type = "negative";
  else type = "mixed";

  if (!sample && news[0]?.title) sample = news[0].title;
  return { type, sample, positiveCount: pos, negativeCount: neg };
}

function sectorLabel(profile?: CompanyProfile): string | undefined {
  if (!profile) return undefined;
  return profile.industry || profile.sector;
}

function isTechIndustry(profile?: CompanyProfile): boolean {
  if (!profile) return false;
  const s = (profile.sector ?? "").toLowerCase();
  const i = (profile.industry ?? "").toLowerCase();
  return (
    s.includes("tech") ||
    i.includes("software") ||
    i.includes("semi") ||
    i.includes("cyber") ||
    i.includes("ai") ||
    i.includes("cloud") ||
    i.includes("internet")
  );
}

function capLabelHebrew(marketCap?: number): string | undefined {
  if (!marketCap) return undefined;
  if (marketCap >= 200_000_000_000) return "מגה-קאפ";
  if (marketCap >= 10_000_000_000) return "Large-Cap";
  if (marketCap >= 2_000_000_000) return "Mid-Cap";
  if (marketCap >= 300_000_000) return "Small-Cap";
  return "Micro-Cap";
}

// One-line summary used for skeleton stocks (Top Movers / Negative / Most Active tables)
export function explainWhyHebrew(
  stock: Stock,
  profile: CompanyProfile | undefined,
  news: NewsItem[]
): string {
  const drivers = detectDrivers(news);
  const direction = stock.changePercent >= 0 ? "עליה" : "ירידה";
  const absChange = Math.abs(stock.changePercent).toFixed(2);
  const volM = (stock.volume / 1_000_000).toFixed(1);
  const companyName = profile?.name ?? stock.ticker;
  const sector = sectorLabel(profile);
  const sectorText = sector ? ` (${sector})` : "";
  const headline = `${companyName}${sectorText} רשמה ${direction} של ${absChange}% במחזור של כ-${volM}M מניות.`;

  switch (drivers.type) {
    case "positive":
      return `${headline} הסיבה ככל הנראה: חדשות חיוביות${drivers.sample ? ` – "${drivers.sample}"` : ""}.`;
    case "negative":
      return `${headline} הסיבה ככל הנראה: חדשות שליליות${drivers.sample ? ` – "${drivers.sample}"` : ""}.`;
    case "mixed":
      return `${headline} הרקע מעורב: גם חדשות חיוביות וגם שליליות${drivers.sample ? ` (לדוגמה: "${drivers.sample}")` : ""}.`;
    case "none":
      return `${headline} לא זוהו חדשות חזקות – ייתכן תנועה טכנית, מומנטום סקטוריאלי או זרימת כסף.`;
  }
}

// Hebrew rationale tailored to a long-term investor:
// "למה משקיע ארוך טווח צריך להתעניין במניה"
export function explainLongTermWhyHebrew(
  stock: Stock,
  profile: CompanyProfile | undefined,
  news: NewsItem[]
): string {
  const name = profile?.name ?? watchlistName(stock.ticker) ?? stock.ticker;
  const parts: string[] = [];

  // Index membership / blue-chip status.
  const indexLabels: string[] = [];
  if (isNasdaq100(stock.ticker)) indexLabels.push('נאסד"ק 100');
  if (isSp500(stock.ticker)) indexLabels.push("S&P 500");
  if (indexLabels.length > 0) {
    parts.push(
      `${name} נמנית עם מדדי ${indexLabels.join(" ו-")}, כלומר חברה מובילה עם נזילות גבוהה ותשומת לב מוסדית – בסיס טוב לאחזקה ארוכת טווח.`
    );
  } else {
    parts.push(
      `${name} עברה את סינון האיכות (מחיר, שווי שוק ובורסה ראשית) ולכן מתאימה לבחינה כאחזקה ארוכת טווח.`
    );
  }

  // Size / stability.
  const cap = profile?.marketCap;
  if (cap !== undefined) {
    if (cap >= 200_000_000_000) {
      parts.push(
        `שווי שוק של מעל $200B מעניק יציבות, גישה להון זול ועמידות יחסית בתקופות תנודתיות.`
      );
    } else if (cap >= 50_000_000_000) {
      parts.push(
        `שווי שוק גדול (Large-Cap) משלב ביסוס עסקי עם פוטנציאל צמיחה מתמשך.`
      );
    } else if (cap >= 10_000_000_000) {
      parts.push(
        `שווי שוק של עשרות מיליארדי דולרים – חברה מבוססת שעדיין בשלב צמיחה.`
      );
    } else {
      parts.push(
        `כחברת Mid-Cap היא מציעה פוטנציאל צמיחה גבוה יותר, אך עם תנודתיות גדולה יותר – יש לאזן את גודל הפוזיציה.`
      );
    }
  }

  // Profitability.
  if (profile?.eps !== undefined) {
    if (profile.eps > 0) {
      parts.push(
        `החברה רווחית (EPS חיובי)${profile.profitMargin !== undefined && profile.profitMargin > 0 ? ` עם שולי רווח של כ-${(profile.profitMargin * 100).toFixed(0)}%` : ""} – יסוד פיננסי שתומך בצמיחה בת-קיימא.`
      );
    } else {
      parts.push(
        `שימו לב: החברה עדיין אינה רווחית (EPS שלילי) – פרופיל צמיחה/סיכון גבוה יותר שמתאים רק לחלק ספקולטיבי קטן בתיק.`
      );
    }
  }

  // Sector leadership.
  if (isTechIndustry(profile)) {
    parts.push(
      `פעילות בליבת הטכנולוגיה/AI/סייבר ממצבת אותה במגמות צמיחה ארוכות-טווח מובילות בשוק.`
    );
  }

  return parts.slice(0, 4).join(" ");
}

// 2–4 sentence "why is this interesting?" briefing for the Top 3 opportunities
export function explainOpportunityHebrew(
  stock: Stock,
  profile: CompanyProfile | undefined,
  news: NewsItem[]
): string {
  const drivers = detectDrivers(news);
  const sentences: string[] = [];
  const companyName = profile?.name ?? stock.ticker;
  const sector = sectorLabel(profile);
  const direction = stock.changePercent >= 0 ? "עליה" : "ירידה";
  const absChange = Math.abs(stock.changePercent).toFixed(2);
  const volM = (stock.volume / 1_000_000).toFixed(1);
  const capLbl = capLabelHebrew(profile?.marketCap);

  // Sentence 1 – framing
  sentences.push(
    `${companyName} (${stock.ticker})${sector ? ` מסקטור ${sector}` : ""}${capLbl ? ` בקטגוריית ${capLbl}` : ""} רשמה ${direction} של ${absChange}% במחזור של כ-${volM}M מניות.`
  );

  // Sentence 2 – driver
  switch (drivers.type) {
    case "positive":
      sentences.push(
        `הזרז המרכזי הוא ככל הנראה זרם חדשות חיוביות${drivers.sample ? ` (לדוגמה: "${drivers.sample}")` : ""}, מה שמחזק את התזה לטווח הקצר.`
      );
      break;
    case "negative":
      sentences.push(
        `דווקא הירידה החדה יכולה להוות הזדמנות מחקר${drivers.sample ? ` – כותרת בולטת: "${drivers.sample}"` : ""}, אך נדרשת בדיקת עומק לפני כל פעולה.`
      );
      break;
    case "mixed":
      sentences.push(
        `התמונה החדשותית מעורבת – יש גם זרזים חיוביים וגם שליליים, מה שמסביר את התנודתיות הגבוהה.`
      );
      break;
    case "none":
      sentences.push(
        `לא זוהה זרז חדשותי ברור, כך שייתכן שמדובר בתנועה טכנית או במומנטום סקטוריאלי שזולג מענפים סמוכים.`
      );
      break;
  }

  // Sentence 3 – context
  if (isTechIndustry(profile)) {
    sentences.push(
      `החברה פועלת בענף טכנולוגיה/AI/סייבר – ענפים שמובילים את שוק הצמיחה בנאסד"ק ומקבלים תשומת לב מוסדית גבוהה.`
    );
  } else if (sector) {
    sentences.push(
      `החברה אינה בליבת הטכנולוגיה, אך תנועה חזקה בסקטור ${sector} יכולה להעיד על רוטציה בשוק.`
    );
  }

  // Sentence 4 – market cap context (only for top 4 limit if not already 4)
  if (sentences.length < 4 && capLbl) {
    if (capLbl === "מגה-קאפ" || capLbl === "Large-Cap") {
      sentences.push(
        `שווי השוק הגדול מספק יציבות יחסית ונזילות גבוהה, אך מגביל את פוטנציאל ה-upside המהיר.`
      );
    } else if (capLbl === "Mid-Cap") {
      sentences.push(
        `כ-Mid-Cap, החברה משלבת פוטנציאל צמיחה עם נזילות סבירה – תמהיל אופייני להזדמנויות איכותיות.`
      );
    } else {
      sentences.push(
        `כחברה קטנה, יש פוטנציאל תנודתיות חדה לכיוונים – פוזיציה דורשת מניהול סיכון הדוק.`
      );
    }
  }

  return sentences.slice(0, 4).join(" ");
}

// 1–3 risk bullets for each opportunity
export function listRisksHebrew(
  stock: Stock,
  profile: CompanyProfile | undefined,
  news: NewsItem[]
): string[] {
  const risks: string[] = [];
  const drivers = detectDrivers(news);
  const absChange = Math.abs(stock.changePercent);

  if (absChange >= 10) {
    risks.push(
      `תנודתיות גבוהה (${absChange.toFixed(1)}% ביום) – סיכון מוגבר לתנועות הפוכות חדות.`
    );
  }

  if (profile?.marketCap && profile.marketCap < 2_000_000_000) {
    risks.push(
      `שווי שוק נמוך (${(profile.marketCap / 1e9).toFixed(2)}B$) – נזילות מוגבלת וסיכון Slippage.`
    );
  }

  if (drivers.type === "negative") {
    risks.push(
      `כותרות שליליות אחרונות – ייתכן שלחץ מימוש או דה-rating ימשיכו בטווח הקצר.`
    );
  } else if (drivers.type === "mixed") {
    risks.push(
      `אי-ודאות חדשותית (חדשות חיוביות ושליליות במקביל) – קשה לזהות מגמה ברורה.`
    );
  } else if (drivers.type === "none") {
    risks.push(
      `אין זרז חדשותי ברור – המומנטום עלול להיעלם מהר אם התנועה היא ספקולטיבית בלבד.`
    );
  }

  if (stock.category === "loser") {
    risks.push(
      `המניה הופיעה ברשימת היורדים – יש מגמת ירידה פעילה ש"תפיסת סכין נופלת" מסוכנת בה.`
    );
  }

  if (profile?.peRatio && profile.peRatio > 80) {
    risks.push(
      `יחס PE גבוה במיוחד (${profile.peRatio.toFixed(0)}) – תמחור יקר, רגיש לכל אכזבה ברווחיות.`
    );
  }

  if (risks.length === 0) {
    risks.push(
      "סיכון שוק כללי – אף מניה אינה חסינה מתנודות מאקרו, ריבית או חדשות גיאופוליטיות."
    );
  }

  return risks.slice(0, 3);
}
