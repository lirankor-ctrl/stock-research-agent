import { EarningsCalendarResult } from "./earningsCalendar";
import { EarningsCalendarEntry, MarketCatalystResult, MarketCatalystStatus } from "./types";

// Only earnings within this window are catalyst-worthy; further out belongs
// in the calendar/week-ahead sections, not the highlighted catalyst card.
const CATALYST_WINDOW_DAYS = 7;

const PRIORITY_RANK: Record<EarningsCalendarEntry["priority"], number> = {
  watchlist: 0,
  topOpportunity: 1,
  megaCap: 2,
};

function timingHebrew(daysRemaining: number): string {
  if (daysRemaining <= 0) return "היום";
  if (daysRemaining === 1) return "מחר";
  return `בעוד ${daysRemaining} ימים`;
}

// Picks the single most important upcoming event from the (already fetched,
// real) earnings calendar. Non-earnings macro catalysts (FOMC, etc.) are out
// of scope – there is no live data source for future macro event dates, so we
// never guess one. Mirrors the calendar's own tri-state status: if the
// calendar itself is unavailable, this must say so too – it must NEVER
// collapse "we don't know" into "no catalyst".
export function selectMarketCatalyst(calendar: EarningsCalendarResult): MarketCatalystResult {
  if (calendar.status === "unavailable") {
    return { catalyst: null, status: "unavailable" };
  }

  const candidates = calendar.entries.filter((e) => e.daysRemaining <= CATALYST_WINDOW_DAYS);
  if (candidates.length === 0) {
    return { catalyst: null, status: "noneFound" };
  }

  const best = [...candidates].sort((a, b) => {
    if (a.daysRemaining !== b.daysRemaining) return a.daysRemaining - b.daysRemaining;
    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  })[0];

  const timingSuffix =
    best.timeOfDay === "pre-market" ? " (Before Market)" : best.timeOfDay === "post-market" ? " (After Market)" : "";

  return {
    catalyst: {
      headline: `${best.name} Earnings${timingSuffix}`,
      ticker: best.ticker,
      reportDate: best.reportDate,
      daysRemaining: best.daysRemaining,
      timingHebrew: timingHebrew(best.daysRemaining),
    },
    status: "confirmed",
  };
}

export function marketCatalystStatusMessageHebrew(status: MarketCatalystStatus): string {
  switch (status) {
    case "unavailable":
      return "נתוני לוח הרווחים אינם זמינים כרגע – לא ניתן לאשר אם קיים קטליזטור מהותי קרוב. אירועי מאקרו עתידיים (החלטות ריבית וכו') אינם זמינים דרך מקור נתונים חי בכל מקרה.";
    case "noneFound":
      return "לא זוהה קטליזטור מהותי (דיווח רווחים) ב-7 הימים הקרובים. אירועי מאקרו עתידיים (החלטות ריבית, פרסומי מדדים מתוכננים) אינם זמינים דרך מקור נתונים חי – Unavailable.";
    case "confirmed":
      return "אירועי מאקרו נוספים (החלטות ריבית של הפד וכו') אינם זמינים דרך מקור נתונים חי כרגע – Unavailable.";
  }
}
