import { ISRAEL_TZ, zonedParts } from "./dateUtils";
import { MAX_EARLINESS_MINUTES, MAX_LATENESS_MINUTES, scheduleDelayMinutes } from "./reportTiming";

// ===== Did the cron fire when we asked it to? =====
//
// This module used to try to answer "does the workflow's `timezone:` key take
// effect?". Run 35002540222 settled that from production data, so the question
// is gone and so is the key:
//
//   The workflow ran `cron: '5 16 * * 1-5'` with `timezone: "Asia/Jerusalem"`.
//   If that key applied, the cron meant 13:05 UTC. The immediately preceding
//   era ran a real `cron: '10 13'` (no timezone key, so unambiguously 13:05–
//   13:10 UTC) and was measured 15 times at a 41–83 minute delay. Under the
//   "timezone applied" reading the same 13:0x UTC load window would have had
//   to jump to a 225–384 minute delay the day the key was added, and jump back
//   if it were removed. Under the "not applied" reading the cron simply meant
//   16:05 UTC and the delay stayed 45–204 minutes — the same band as always.
//   The second reading is the only one consistent with the other 35 runs.
//
// `timezone:` is real GitHub syntax but is still Public Preview
// (github/roadmap#1187) and demonstrably did not take effect for this repo, so
// the workflow now carries explicit UTC crons — one per Israeli UTC offset.
//
// What is left worth measuring every run is the thing that actually varies:
// how far off the target the job really started, and whether that offset looks
// like the off-season cron rather than ordinary scheduler lag.

export type ScheduleVerdict = "onTarget" | "late" | "early";

export interface ScheduleDiagnosis {
  // Signed minutes from the Israel wall-clock target to the actual job start.
  delayMinutes: number;
  verdict: ScheduleVerdict;
  // True when the offset is within ~10 min of a full hour in either direction:
  // the signature of the wrong seasonal cron firing during March/October,
  // as opposed to GitHub's ordinary (and much more variable) scheduler lag.
  looksLikeDstDrift: boolean;
  startedIsraelDisplay: string;
  reasonHebrew: string;
}

// Israel's DST shift is exactly 60 minutes; allow a window for the scheduler
// lag that rides on top of it.
const DST_DRIFT_MINUTES = 60;
const DST_DRIFT_TOLERANCE = 10;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function diagnoseSchedule(opts: {
  workflowStartedAt: Date;
  // The Israel wall-clock time the cron is meant to represent.
  targetHourIsrael: number;
  targetMinuteIsrael: number;
}): ScheduleDiagnosis {
  const { workflowStartedAt, targetHourIsrael, targetMinuteIsrael } = opts;
  const delayMinutes = scheduleDelayMinutes(workflowStartedAt, targetHourIsrael, targetMinuteIsrael);

  const verdict: ScheduleVerdict =
    delayMinutes > MAX_LATENESS_MINUTES
      ? "late"
      : delayMinutes < -MAX_EARLINESS_MINUTES
      ? "early"
      : "onTarget";

  const looksLikeDstDrift =
    Math.abs(Math.abs(delayMinutes) - DST_DRIFT_MINUTES) <= DST_DRIFT_TOLERANCE;

  const started = zonedParts(workflowStartedAt, ISRAEL_TZ);
  const startedIsraelDisplay = `${pad2(started.hour)}:${pad2(started.minute)}`;
  const targetDisplay = `${pad2(targetHourIsrael)}:${pad2(targetMinuteIsrael)}`;

  const reasonHebrew =
    verdict === "onTarget"
      ? `GitHub התחיל את הריצה ב-${startedIsraelDisplay} שעון ישראל, ` +
        `${delayMinutes >= 0 ? `${delayMinutes} דקות אחרי` : `${Math.abs(delayMinutes)} דקות לפני`} ` +
        `היעד (${targetDisplay}) – בתוך החלון התקין.`
      : verdict === "late"
      ? `GitHub התחיל את הריצה ב-${startedIsraelDisplay} שעון ישראל, ${delayMinutes} דקות אחרי היעד ` +
        `(${targetDisplay}), מעבר לתקרה של ${MAX_LATENESS_MINUTES} דקות. ` +
        (looksLikeDstDrift
          ? `האיחור קרוב לשעה בדיוק – כנראה ה-cron של העונה הלא-נכונה (מעבר שעון).`
          : `זהו האיחור של מתזמן ה-cron של GitHub עצמו, לא באג בקוד.`)
      : `GitHub התחיל את הריצה ב-${startedIsraelDisplay} שעון ישראל, ` +
        `${Math.abs(delayMinutes)} דקות לפני היעד (${targetDisplay}). ` +
        (looksLikeDstDrift
          ? `ההקדמה קרובה לשעה בדיוק – זהו ה-cron של העונה הלא-נכונה (מעבר שעון בישראל).`
          : `הריצה הוקדמה מסיבה לא צפויה.`);

  return { delayMinutes, verdict, looksLikeDstDrift, startedIsraelDisplay, reasonHebrew };
}
