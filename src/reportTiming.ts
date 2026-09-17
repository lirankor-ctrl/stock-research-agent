import { ISRAEL_TZ, US_MARKET_TZ, usMarketDateIso, zonedParts } from "./dateUtils";
import { isUsMarketHoliday, usMarketCloseMinute, usMarketHolidayName } from "./marketCalendar";

// ===== Report timing / staleness guard =====
//
// Root cause of the 2026-08-28 incident: GitHub's scheduler fired the
// workflow ~9h50m late (23:00 UTC instead of ~13:10 UTC — confirmed via the
// GitHub Actions API; the cron itself never changed). GitHub Actions gives
// no hard guarantee on `schedule` trigger timing, so the fix cannot live in
// the cron alone. This module makes the app itself refuse to silently mail
// a "pre-market" report at a time when that label would be misleading.

export type ReportTimingStatus = "onTime" | "delayed" | "intraday" | "skip";

// ===== The delivery contract these three thresholds encode =====
//
// Requested: the email ARRIVES between 16:00 and 16:10 Israel time.
// The cron therefore targets 15:58 Israel (SCHEDULED_*_ISRAEL in the
// workflow), because measured creation→delivery for this pipeline is
// 3m16s (run 35002540222: job created 17:38:36Z, email sent 17:41:5xZ),
// with a historical generation range of 108–247s. 15:58 + 2–4 min lands
// inside 16:00–16:10 from both ends of that range.
//
// Everything below is expressed as "minutes after the 15:58 target that
// GitHub actually STARTED the job", because start time + ~3 min is arrival
// time. That makes each threshold directly readable as an arrival time.

// Started >12 min late ⇒ arrives after ~16:13, i.e. outside the requested
// 16:00–16:10 window. Still before the US open, so it is delivered, but
// labeled "Delayed" instead of being passed off as the normal 16:00 report.
export const DELAYED_THRESHOLD_MINUTES = 12;

// Hard lateness cap. Started >30 min late ⇒ arrives after ~16:31. That is no
// longer "the 16:00 pre-market report", so it is NOT mailed at all — even if
// the US market technically happens to still be open. This is the explicit
// instruction: no stale report is preferable to a "16:00 report" at 20:30.
//
// Why 30 and not 180/240: 180+ was chosen back when the cron itself was
// ~3h off (the `timezone:` key never took effect, so '5 16' fired at 16:05
// UTC = 19:05 Israel) and a tight cap would have suppressed every email
// instead of exposing the wrong cron. The cron is now explicit UTC and
// correct, so the cap can finally express the actual requirement.
//
// ===== Operational warning =====
// GitHub's own scheduler is the remaining problem, and this cap cannot fix
// it. Across all 47 historical scheduled runs in this repo the delay between
// the cron instant and the job starting was 41–591 minutes (median ~52–68);
// not one run ever started within 40 minutes of its cron. So while triggering
// stays cron-only, a 30-minute cap will skip most days. The fix for THAT is
// an external, punctual trigger (workflow_dispatch with production_run=true —
// see the workflow), not a looser cap. MAX_LATENESS_MINUTES stays
// env-overridable so the trade-off can be changed without a code edit — which
// is exactly what migration phase 1 relies on: the workflow raises it to 240
// while the native cron is still the only delivery path, and deleting that one
// line restores 30.
export const MAX_LATENESS_MINUTES = Number(process.env.MAX_LATENESS_MINUTES ?? 30);

// Hard earliness cap. A run that starts >15 min EARLY would deliver before
// 15:46, which is equally not the requested window — and it is the exact
// signature of the wrong seasonal cron firing: the workflow carries two UTC
// crons (12:58Z for IDT, 13:58Z for IST) and both fire during March and
// October, when Israel switches. The off-season one is ~60 min out, so this
// cap is what silently discards it instead of mailing two reports an hour
// apart.
export const MAX_EARLINESS_MINUTES = Number(process.env.MAX_EARLINESS_MINUTES ?? 15);

export type ScheduleLatenessVerdict = "ok" | "tooLate" | "tooEarly";

export interface ScheduleLateness {
  // Signed: positive = started after the target, negative = started before.
  delayMinutes: number;
  verdict: ScheduleLatenessVerdict;
}

// Minutes between the target Israel wall-clock time and when the job actually
// started, as a SIGNED value.
//
// The day-wrap correction matters: a run that GitHub starts after local
// midnight has a tiny minuteOfDay, so the raw subtraction reads as ~14 hours
// EARLY when it is really ~10 hours LATE. That is exactly the 2026-08-28
// 02:04 IDT incident shape, and without this it would be reported as the
// wrong failure. Anything more than 12 hours "early" is re-read as late.
export function scheduleDelayMinutes(
  startedAt: Date,
  scheduledHourIsrael: number,
  scheduledMinuteIsrael: number
): number {
  const started = zonedParts(startedAt, ISRAEL_TZ);
  let delta = started.minuteOfDay - (scheduledHourIsrael * 60 + scheduledMinuteIsrael);
  if (delta < -720) delta += 1440;
  return delta;
}

// The cheap half of the staleness guard: it needs only the clock, never the
// report. src/emailReport.ts runs this BEFORE generation so a run GitHub
// started hours late is abandoned in seconds, instead of burning ~3 minutes
// and ~32 Alpha Vantage calls against a 25/day free-tier ceiling to build a
// report that is then thrown away.
export function classifyScheduleLateness(opts: {
  workflowStartedAt: Date;
  scheduledHourIsrael: number;
  scheduledMinuteIsrael: number;
}): ScheduleLateness {
  const delayMinutes = scheduleDelayMinutes(
    opts.workflowStartedAt,
    opts.scheduledHourIsrael,
    opts.scheduledMinuteIsrael
  );
  if (delayMinutes > MAX_LATENESS_MINUTES) return { delayMinutes, verdict: "tooLate" };
  if (delayMinutes < -MAX_EARLINESS_MINUTES) return { delayMinutes, verdict: "tooEarly" };
  return { delayMinutes, verdict: "ok" };
}

// US regular session: opens 09:30 America/New_York on trading days. The close
// is 16:00 normally and 13:00 on the three recurring NYSE half-days — see
// src/marketCalendar.ts, which also supplies the full-closure holiday list.
const MARKET_OPEN_MINUTE = 9 * 60 + 30;

export type UsMarketState = "pre-market" | "open" | "after-hours" | "weekend" | "holiday";

export function usMarketState(now: Date): UsMarketState {
  const p = zonedParts(now, US_MARKET_TZ);
  if (p.weekday === 0 || p.weekday === 6) return "weekend";
  const dateIso = usMarketDateIso(now);
  // A full closure is decided before the clock: on a holiday there is no
  // pre-market, no session and no close. The 2026-09-07 run mailed a normal
  // pre-market report on Labor Day precisely because this check didn't exist.
  if (isUsMarketHoliday(dateIso)) return "holiday";
  if (p.minuteOfDay < MARKET_OPEN_MINUTE) return "pre-market";
  // An early close makes the session end at 13:00 ET. Getting this wrong
  // would leave the run thinking the market was still open for three hours
  // after it shut, which also feeds the earnings-reaction settled-session
  // check in src/earningsReaction.ts.
  if (p.minuteOfDay < usMarketCloseMinute(dateIso)) return "open";
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
  // The instant GitHub actually started the job, when known. `now` is the
  // clock at SEND time and must keep driving the market-state decision (the
  // question "is a pre-market report misleading right now?" is about now).
  // But schedule delay is a property of when GitHub started us, not of how
  // long generation took – measuring it from `now` silently added the whole
  // pipeline duration (~2–4 min) to every reported delay.
  workflowStartedAt?: Date;
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
  const { now, scheduledHourIsrael, scheduledMinuteIsrael, isManualRun, workflowStartedAt } = input;
  const nowIsrael = zonedParts(now, ISRAEL_TZ);
  const scheduledIsraelDisplay = `${pad2(scheduledHourIsrael)}:${pad2(scheduledMinuteIsrael)}`;
  const actualIsraelDisplay = `${pad2(nowIsrael.hour)}:${pad2(nowIsrael.minute)}`;
  // Schedule delay is a property of when GitHub started us, not of how long
  // generation took — measuring it from `now` silently adds the whole pipeline
  // duration (~2–4 min) to every reported delay. Signed, so a run that fired
  // an hour early (off-season cron) is distinguishable from a late one.
  const delayMinutes = scheduleDelayMinutes(
    workflowStartedAt ?? now,
    scheduledHourIsrael,
    scheduledMinuteIsrael
  );
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

  // Full US market closure. Checked before everything else that follows: on a
  // holiday there is no session for a pre-market report to inform, so how
  // late the run started is irrelevant. Manual runs still bypass this above,
  // because an operator asking for a report on a closed day is asking
  // deliberately.
  if (marketState === "holiday") {
    const holiday = usMarketHolidayName(usMarketDateIso(now)) ?? "US market holiday";
    return {
      status: "skip",
      delayMinutes,
      scheduledIsraelDisplay,
      actualIsraelDisplay,
      usMarketStateAtRun: marketState,
      reasonHebrew:
        `שוק המניות בארה"ב סגור היום (${holiday}) – אין מסחר, ולכן דוח טרום-מסחר לא רלוונטי. ` +
        `הדוח לא נשלח; קבצי האבחון עדיין נשמרו תחת reports/.`,
      reportLabel: "Report Skipped (US Market Holiday)",
    };
  }

  // Started so far past the target that the report can no longer do the job
  // it exists for. Checked BEFORE the market-state branches: "the US market
  // happens to still be open" does not make a 4-hour-late daily pre-market
  // report useful, and mailing it anyway is exactly the failure this whole
  // module exists to stop — run 35002540222 started 20:38 Israel, was
  // relabeled "Intraday" purely because the US market was still open, and
  // was mailed at 20:41 as if it were the 16:00 report.
  if (delayMinutes > MAX_LATENESS_MINUTES) {
    return {
      status: "skip",
      delayMinutes,
      scheduledIsraelDisplay,
      actualIsraelDisplay,
      usMarketStateAtRun: marketState,
      reasonHebrew:
        `GitHub התחיל את הריצה ${delayMinutes} דקות אחרי היעד (${scheduledIsraelDisplay} שעון ישראל), ` +
        `מעבר לתקרה של ${MAX_LATENESS_MINUTES} דקות. דוח יומי שמגיע כל כך מאוחר כבר לא משרת את מטרתו – ` +
        `הוא לא נשלח. קבצי האבחון נשמרו תחת reports/.`,
      reportLabel: "Report Skipped (Too Late)",
    };
  }

  // Started materially BEFORE the target. Two causes, both of which must not
  // produce an email: the off-season cron firing during a DST-changeover month
  // (the workflow carries one UTC cron per Israeli offset, and both fire in
  // March/October), or a manual re-trigger of the schedule. Either way a
  // report delivered at, say, 14:58 is not the 16:00 report.
  if (delayMinutes < -MAX_EARLINESS_MINUTES) {
    return {
      status: "skip",
      delayMinutes,
      scheduledIsraelDisplay,
      actualIsraelDisplay,
      usMarketStateAtRun: marketState,
      reasonHebrew:
        `הריצה התחילה ${Math.abs(delayMinutes)} דקות לפני היעד (${scheduledIsraelDisplay} שעון ישראל) – ` +
        `מעבר לתקרה של ${MAX_EARLINESS_MINUTES} דקות. זו החתימה של ה-cron של העונה הלא-נכונה ` +
        `(מרץ/אוקטובר, מעבר שעון בישראל); הדוח לא נשלח כדי לא לשלוח שני דוחות בהפרש שעה.`,
      reportLabel: "Report Skipped (Too Early)",
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
