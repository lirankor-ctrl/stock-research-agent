// Filesystem IO for the performance subsystem. Everything lives under
// reports/performance/ so it sits next to the report the committee already reads.
//
// ===== Why every write here goes through a temp file + rename =====
// These files are now COMMITTED production state (the workflow pushes
// reports/performance/ back to the repo), so a torn write is not a local
// annoyance any more — it is permanent data loss. loadLedger deliberately
// swallows a parse error and returns [], because crashing the whole report over
// a corrupt ledger would be worse. But that same forgiveness means a
// half-written ledger silently discards MONTHS of recommendation history and
// starts the book from scratch, with nothing in the logs to say it happened.
// A direct fs.writeFileSync leaves exactly that window open on any crash,
// timeout or runner eviction mid-write. rename() is atomic on POSIX and on
// NTFS, so a reader sees either the old complete file or the new complete
// file — never a partial one. This mirrors src/earningsTracker.ts, which
// already got this right.

import fs from "fs";
import path from "path";
import { Metrics, RecommendationRecord, RunSnapshot } from "./types";
import { usMarketDateIso } from "../dateUtils";

function perfDir(reportsDir: string): string {
  const dir = path.join(reportsDir, "performance");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, file);
}

export function loadLedger(reportsDir: string): RecommendationRecord[] {
  const file = path.join(perfDir(reportsDir), "ledger.json");
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as RecommendationRecord[]) : [];
  } catch {
    return []; // corrupt ledger should never crash a run
  }
}

export function saveLedger(reportsDir: string, ledger: RecommendationRecord[]): string {
  const file = path.join(perfDir(reportsDir), "ledger.json");
  writeAtomic(file, JSON.stringify(ledger, null, 2));
  return file;
}

export function saveMetrics(reportsDir: string, metrics: Metrics): string {
  const file = path.join(perfDir(reportsDir), "metrics.json");
  writeAtomic(file, JSON.stringify(metrics, null, 2));
  return file;
}

export function loadRunSnapshots(reportsDir: string): RunSnapshot[] {
  const file = path.join(perfDir(reportsDir), "runs.jsonl");
  if (!fs.existsSync(file)) return [];
  const out: RunSnapshot[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RunSnapshot;
      // Backfill for lines written before `tradingDate` existed. Every historical
      // line has generatedAt, and the trading date is derivable from it, so the
      // pre-existing trend history stays usable instead of being dropped or
      // permanently un-dedupable.
      if (!parsed.tradingDate && parsed.generatedAt) {
        parsed.tradingDate = usMarketDateIso(new Date(parsed.generatedAt));
      }
      if (!parsed.tradingDate) continue; // nothing to key on – unusable
      out.push(parsed);
    } catch {
      // Skip an unparseable line rather than discarding the whole trend file.
    }
  }
  return out;
}

// Collapses the trend history to exactly one snapshot per trading date, keeping
// the LAST run of each day (the most complete picture of it). Idempotent, so it
// doubles as the one-time repair of the legacy append-only file: that file holds
// 50 lines covering 6 distinct days, and the first write after this change
// rewrites it as 6.
function collapseByTradingDate(snapshots: RunSnapshot[]): RunSnapshot[] {
  const latest = new Map<string, RunSnapshot>();
  for (const s of snapshots) {
    const existing = latest.get(s.tradingDate);
    if (!existing || s.generatedAt >= existing.generatedAt) latest.set(s.tradingDate, s);
  }
  return [...latest.values()].sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
}

// One snapshot per TRADING DATE, not one per run.
//
// This used to be a bare fs.appendFileSync, which made runs.jsonl grow by a
// line on every single invocation with no idempotency at all: the file
// currently holds 50 lines covering just 6 distinct days (13 on 2026-07-21,
// 14 on 2026-08-30), every one of them a repeated local dev run. That was
// harmless while the file was untracked. It stops being harmless the moment
// the workflow commits reports/performance/ as production state, because then
// a double trigger — exactly what an external scheduler can do — writes a
// permanent duplicate snapshot into the trend history and skews every chart
// built from it.
//
// Replacing on the same trading date makes a re-run converge instead of
// accumulate: running twice on the same day leaves the state identical to
// running once, which is the property the idempotency guard needs.
export function upsertRunSnapshot(reportsDir: string, snapshot: RunSnapshot): string {
  const file = path.join(perfDir(reportsDir), "runs.jsonl");
  const merged = collapseByTradingDate([
    ...loadRunSnapshots(reportsDir).filter((s) => s.tradingDate !== snapshot.tradingDate),
    snapshot,
  ]);
  writeAtomic(file, merged.map((s) => JSON.stringify(s)).join("\n") + "\n");
  return file;
}
