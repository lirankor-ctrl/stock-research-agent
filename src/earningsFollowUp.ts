import { EarningsTrackerRunResult, runEarningsTracker } from "./earningsTracker";
import { EarningsCalendarEntry, EarningsFollowUpStatus } from "./types";

// Pipeline-facing entry point for the Earnings Follow-up section. All the
// real work (persistence, lifecycle transitions, actual-results fetch,
// reaction calculation, interpretation) lives in earningsTracker.ts /
// earningsResults.ts / earningsReaction.ts – this module just wires that
// into the shape pipeline.ts and the renderers expect. Returns the FULL
// tracker run result (not just the {entries,status,coverage} the section
// renders) because pipeline.ts also needs `records` to filter reported
// events out of the Upcoming Earnings Calendar – see filterOutReported in
// earningsTracker.ts (section 7: an event can't be both upcoming and
// reported).
export interface EarningsFollowUpOptions {
  // Optional override of the tracker store's path – defaults to
  // data/earnings-tracker.json (see DEFAULT_TRACKER_FILE). Tests point this
  // at a temp file; production never overrides it.
  filePath?: string;
  now: Date;
  // Every entry currently shown in Upcoming Earnings Calendar THIS run –
  // this is what gets persisted into the tracker (section 1).
  upcomingEntries: EarningsCalendarEntry[];
  onProgress?: (msg: string) => void;
}

export async function buildEarningsFollowUp(
  opts: EarningsFollowUpOptions
): Promise<EarningsTrackerRunResult> {
  const { filePath, now, upcomingEntries, onProgress = () => {} } = opts;
  return runEarningsTracker({ filePath, now, upcomingEntries, onProgress });
}

export function earningsFollowUpStatusMessageHebrew(status: EarningsFollowUpStatus): string {
  switch (status) {
    case "unavailable":
      return "לא ניתן לאמת תוצאות דיווחים אחרונים כרגע (ספק הנתונים לתוצאות בפועל, Finnhub, אינו מוגדר או אינו זמין) – ישנן חברות שמועד הדיווח הצפוי שלהן כבר חלף, אך לא ניתן לאשר את תוצאותיהן.";
    case "noneFound":
      return "אין חברות שדיווחו רווחים בפועל ב-5 ימי המסחר האחרונים מתוך הרשימה שמעוקבת דרך לוח הרווחים הקרובים.";
    case "confirmed":
      return "";
  }
}
