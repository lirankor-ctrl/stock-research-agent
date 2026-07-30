import { EarningsCalendarResult } from "./earningsCalendar";
import { EconomicReading, WeekAhead } from "./types";

const WEEK_DAYS = 7;

// Combines what we can genuinely source live (real upcoming earnings, latest
// released macro readings) into a "week ahead" briefing. Forward-looking
// macro events (FOMC decisions, scheduled CPI/jobs release dates, Fed speaker
// calendar) have no free live data source and are never guessed – a single
// concise notice says so, rather than a long list of per-field "Unavailable"
// lines.
export function buildWeekAhead(
  earningsCalendar: EarningsCalendarResult,
  economicReadings: EconomicReading[]
): WeekAhead {
  const earnings = earningsCalendar.entries.filter((e) => e.daysRemaining <= WEEK_DAYS);
  const available = economicReadings.filter((r) => r.value !== null);
  const unavailableCount = economicReadings.length - available.length;

  return {
    earnings,
    earningsStatus: earningsCalendar.status,
    economicReadings: available,
    economicUnavailableCount: unavailableCount,
    unavailableNoticeHebrew:
      'לוח אירועים מאקרו עתידי (החלטות ריבית של הפד, תאריכי פרסום מתוכננים של CPI/תעסוקה/PPI, נאומי בכירי הפד) אינו זמין דרך מקור נתונים חי בגרסה זו. הסעיף מציג רק אירועי רווחים מאומתים לשבוע הקרוב, ואת הנתונים המאקרו האחרונים שכבר פורסמו בפועל (לא לוח זמנים קדימה).',
  };
}
