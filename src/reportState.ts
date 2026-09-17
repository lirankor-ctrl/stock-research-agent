import fs from "fs";
import path from "path";

// ===== "Did today's report already go out?" =====
//
// This is the state that makes a duplicate trigger harmless. An external
// scheduler is a second system that can fire twice — a retry after a timeout it
// only *thought* failed, a double-click in the provider's UI, an overlapping
// manual re-run. GitHub Actions' `concurrency` group stops two runs executing
// at the same time, but it does NOT stop the second one from running afterwards
// and mailing a second identical report. Serialization alone is not idempotency.
//
// So the send is keyed on the US TRADING DATE, not on the run: once a report
// for trading date D has been mailed, any later run that resolves to D refuses
// to send. The trading date (not the Israeli calendar date) is the right key
// because the report is about a US session, and it is the same value the rest
// of the pipeline already uses to decide what "today" means.
//
// The file is committed back to the repo by the workflow, which is what lets
// one runner see what a completely separate earlier runner did.

export const REPORT_STATE_FILE = path.join("data", "report-state.json");

export interface ReportState {
  // US trading date (YYYY-MM-DD) of the last successfully SENT report.
  lastSentUsTradingDate: string | null;
  lastSentAtIso: string | null;
  lastSentMessageId: string | null;
  // GitHub run id that sent it, so a duplicate can be traced to its origin.
  lastSentRunId: string | null;
  // Event that produced the send (workflow_dispatch / schedule), which is how
  // you tell "the external scheduler is working" from "only the fallback ran".
  lastSentEvent: string | null;
}

export const EMPTY_REPORT_STATE: ReportState = {
  lastSentUsTradingDate: null,
  lastSentAtIso: null,
  lastSentMessageId: null,
  lastSentRunId: null,
  lastSentEvent: null,
};

// Tolerant on purpose. A missing file is the normal first-run case, and a
// corrupt one must not crash the report — but note the asymmetry with the
// ledger: losing this file means at worst ONE duplicate email, whereas treating
// a corrupt file as "already sent" would silently suppress the report forever.
// So the safe failure direction here is "assume nothing was sent".
export function parseReportState(raw: string | null | undefined): ReportState {
  if (!raw || !raw.trim()) return { ...EMPTY_REPORT_STATE };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return { ...EMPTY_REPORT_STATE };
    return {
      lastSentUsTradingDate: typeof data.lastSentUsTradingDate === "string" ? data.lastSentUsTradingDate : null,
      lastSentAtIso: typeof data.lastSentAtIso === "string" ? data.lastSentAtIso : null,
      lastSentMessageId: typeof data.lastSentMessageId === "string" ? data.lastSentMessageId : null,
      lastSentRunId: typeof data.lastSentRunId === "string" ? data.lastSentRunId : null,
      lastSentEvent: typeof data.lastSentEvent === "string" ? data.lastSentEvent : null,
    };
  } catch {
    return { ...EMPTY_REPORT_STATE };
  }
}

export function loadReportState(filePath: string = REPORT_STATE_FILE): ReportState {
  if (!fs.existsSync(filePath)) return { ...EMPTY_REPORT_STATE };
  try {
    return parseReportState(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { ...EMPTY_REPORT_STATE };
  }
}

// Temp file + rename, for the same reason the earnings tracker does it: this is
// committed state, and a torn write here would either resend or suppress.
export function saveReportState(state: ReportState, filePath: string = REPORT_STATE_FILE): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

// `committedTradingDate` must come from origin/main, NOT from the checked-out
// working copy. A run triggered before an earlier run pushed would otherwise be
// looking at a stale checkout and would happily send a second email — the exact
// race the guard exists to close. The workflow does `git fetch` + `git show
// origin/main:...` and hands the answer in via env.
export function alreadySentForTradingDate(
  committedTradingDate: string | null,
  tradingDate: string
): boolean {
  return !!committedTradingDate && committedTradingDate === tradingDate;
}
