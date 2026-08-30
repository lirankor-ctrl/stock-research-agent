import { ISRAEL_TZ, US_MARKET_TZ, zonedParts } from "./dateUtils";

// ===== Report timing / staleness guard =====
//
// Root cause of the 2026-08-28 incident: GitHub's scheduler fired the
// workflow ~9h50m late (23:00 UTC instead of ~13:10 UTC — confirmed via the
// GitHub Actions API; the cron itself never changed). GitHub Actions gives
// no hard guarantee on `schedule` trigger timing, so the fix cannot live in
// the cron alone. This module makes the app itself refuse to silently mail
// a "pre-market" report at a time when that label would be misleading.

export type ReportTimingStatus = "onTime" | "delayed" | "intraday" | "skip";

// More than this many minutes late (but still before the US market opens)
// gets visibly labeled "delayed" rather than presented as a normal on-time
// pre-market report.
export const DELAYED_THRESHOLD_MINUTES = 45;

// US regular session: 09:30–16:00 America/New_York, Monday–Friday. (Market
// holidays are not modeled here — a known, deliberate simplification; a
// holiday would show as "market closed" at a time it's actually a US
// holiday closure, which still correctly prevents a misleading send.)
const MARKET_OPEN_MINUTE = 9 * 60 + 30;
const MARKET_CLOSE_MINUTE = 16 * 60;

export type UsMarketState = "pre-market" | "open" | "after-hours" | "weekend";

export function usMarketState(now: Date): UsMarketState {
  const p = zonedParts(now, US_MARKET_TZ);
  if (p.weekday === 0 || p.weekday === 6) return "weekend";
  if (p.minuteOfDay < MARKET_OPEN_MINUTE) return "pre-market";
  if (p.minuteOfDay < MARKET_CLOSE_MINUTE) return "open";
  return "after-hours";
}

export interface ReportTimingInput {
  now: Date;
  scheduledHourIsrael: number;
  scheduledMinuteIsrael: number;
  // true for workflow_dispatch / local manual runs – the staleness guard is
  // bypassed entirely (an operator explicitly asked for a report right now,
  // at whatever time that is; this is not the scheduled pre-market send).
  isManualRun: boolean;
}

export interface ReportTimingResult {
  status: ReportTimingStatus;
  delayMinutes: number;
  scheduledIsraelDisplay: string;
  actualIsraelDisplay: string;
  usMarketStateAtRun: UsMarketState;
  reasonHebrew: string;
  // Subject-line / report-header label. Never used when status === "skip"
  // (no report is sent in that case).
  reportLabel: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function classifyReportTiming(input: ReportTimingInput): ReportTimingResult {
  const { now, scheduledHourIsrael, scheduledMinuteIsrael, isManualRun } = input;
  const nowIsrael = zonedParts(now, ISRAEL_TZ);
  const scheduledIsraelDisplay = `${pad2(scheduledHourIsrael)}:${pad2(scheduledMinuteIsrael)}`;
  const actualIsraelDisplay = `${pad2(nowIsrael.hour)}:${pad2(nowIsrael.minute)}`;
  const scheduledMinuteOfDay = scheduledHourIsrael * 60 + scheduledMinuteIsrael;
  const delayMinutes = Math.max(0, nowIsrael.minuteOfDay - scheduledMinuteOfDay);
  const marketState = usMarketState(now);

  if (isManualRun) {
    return {
      status: "onTime",
      delayMinutes: 0,
      scheduledIsraelDisplay,
      actualIsraelDisplay,
      usMarketStateAtRun: marketState,
      reasonHebrew: "הרצה ידנית (workflow_dispatch) – בדיקת התיישנות דילוג ידע.",
      reportLabel: "Manual Report",
    };
  }

  // Market is open right now – this is no longer a "pre-market" report no
  // matter how it got here. Data is fetched live at the actual run time, so
  // relabeling as an Intraday report (rather than silently keeping the
  // "pre-market" framing) is accurate, not misleading.
  if (marketState === "open") {
    return {
      status: "intraday",
      delayMinutes,
      scheduledIsraelDisplay,
      actualIsraelDisplay,
      usMarketStateAtRun: marketState,
      reasonHebrew:
        `הריצה החלה בשעה ${actualIsraelDisplay} (שעון ישראל), לאחר פתיחת המסחר בארה"ב – ` +
        `הדוח הופק מחדש כ"Intraday Market Report" במקום דוח טרום-מסחר.`,
      reportLabel: "Intraday Market Report",
    };
  }

  // Market closed for the day (after-hours) or it's the weekend – exactly
  // the 2026-08-28 failure mode (email arrived 02:04 IDT, hours after the US
  // close). A "pre-market" report at this hour is not delayed, it's stale
  // and misleading – never send it silently.
  if (marketState === "after-hours" || marketState === "weekend") {
    return {
      status: "skip",
      delayMinutes,
      scheduledIsraelDisplay,
      actualIsraelDisplay,
      usMarketStateAtRun: marketState,
      reasonHebrew:
        `הריצה החלה בשעה ${actualIsraelDisplay} (שעון ישראל), לאחר סגירת המסחר בארה"ב ` +
        `(או בסוף שבוע) – דוח "טרום-מסחר" בשעה הזו יטעה. הדוח לא נשלח; ` +
        `קבצי האבחון עדיין נשמרו תחת reports/.`,
      reportLabel: "Report Skipped (Stale)",
    };
  }

  // Still pre-market (before the US open) – on time vs. visibly delayed.
  if (delayMinutes > DELAYED_THRESHOLD_MINUTES) {
    return {
      status: "delayed",
      delayMinutes,
      scheduledIsraelDisplay,
      actualIsraelDisplay,
      usMarketStateAtRun: marketState,
      reasonHebrew:
        `הריצה החלה בשעה ${actualIsraelDisplay} (שעון ישראל), ${delayMinutes} דקות אחרי היעד ` +
        `(${scheduledIsraelDisplay}) – עדיין לפני פתיחת המסחר, אך הדוח מסומן כ"מתעכב" ולא כרגיל.`,
      reportLabel: "Delayed Pre-Market Report",
    };
  }

  return {
    status: "onTime",
    delayMinutes,
    scheduledIsraelDisplay,
    actualIsraelDisplay,
    usMarketStateAtRun: marketState,
    reasonHebrew: `הריצה החלה בשעה ${actualIsraelDisplay} (שעון ישראל), בתוך חלון היעד התקין.`,
    reportLabel: "Pre-Market Report",
  };
}
