// Filesystem IO for the performance subsystem. Everything lives under
// reports/performance/ so it sits next to the report the committee already reads.

import fs from "fs";
import path from "path";
import { Metrics, RecommendationRecord, RunSnapshot } from "./types";

function perfDir(reportsDir: string): string {
  const dir = path.join(reportsDir, "performance");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
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
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2), "utf8");
  return file;
}

export function saveMetrics(reportsDir: string, metrics: Metrics): string {
  const file = path.join(perfDir(reportsDir), "metrics.json");
  fs.writeFileSync(file, JSON.stringify(metrics, null, 2), "utf8");
  return file;
}

export function appendRunSnapshot(reportsDir: string, snapshot: RunSnapshot): string {
  const file = path.join(perfDir(reportsDir), "runs.jsonl");
  fs.appendFileSync(file, JSON.stringify(snapshot) + "\n", "utf8");
  return file;
}
