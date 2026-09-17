import fs from "fs";
import path from "path";

// ===== Run phase reporting =====
//
// A failure in a non-essential post-send operation must not read as "the
// report failed". Each distinct phase reports its own outcome, both as a
// greppable log line and into reports/run-status.json, so the workflow can
// say exactly which phase broke — in particular "email was delivered but
// state persistence failed", which is a completely different incident from
// "no email went out".

export type RunPhase =
  | "DELIVERY_WINDOW"
  | "REPORT_GENERATION"
  | "EMAIL_SEND"
  | "STATE_PERSISTENCE"
  | "POST_SEND";

export type PhaseOutcome = "ok" | "skipped" | "failed" | "waiting" | "runNow";

export interface PhaseRecord {
  phase: RunPhase;
  outcome: PhaseOutcome;
  detail?: string;
  at: string;
}

export const RUN_STATUS_PATH = path.join("reports", "run-status.json");

const records: PhaseRecord[] = [];

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(RUN_STATUS_PATH), { recursive: true });
    // Written through a temp file + rename so a crash mid-write can never
    // leave a half-parsed status file behind.
    const tmp = `${RUN_STATUS_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ phases: records }, null, 2), "utf8");
    fs.renameSync(tmp, RUN_STATUS_PATH);
  } catch {
    // Status reporting must never be the thing that breaks the run.
  }
}

export function logPhase(phase: RunPhase, outcome: PhaseOutcome, detail?: string): void {
  const rec: PhaseRecord = { phase, outcome, detail, at: new Date().toISOString() };
  records.push(rec);
  persist();
  const icon = outcome === "ok" ? "✅" : outcome === "failed" ? "❌" : outcome === "skipped" ? "⏭️" : "⏳";
  console.log(`${icon} PHASE|${phase}|${outcome}${detail ? `|${detail}` : ""}`);
}

export function phaseRecords(): PhaseRecord[] {
  return [...records];
}
