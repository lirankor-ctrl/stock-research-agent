import fs from "fs";
import path from "path";
import { daysBetweenIso, usMarketDateIso } from "./dateUtils";
import { buildInterpretation, computeEarningsReaction, computeSurprisePct } from "./earningsReaction";
import { EarningsResultRow } from "./earningsResults";
import { getFinnhubEarningsResult, getYahooDailyClosesWithDates, SourcedValue } from "./dataSources";
import { DatedClose } from "./marketData";
import {
  EarningsCalendarEntry,
  EarningsFigureStatus,
  EarningsFollowUpCoverage,
  EarningsFollowUpEntry,
  EarningsFollowUpStatus,
  EarningsReaction,
  EarningsResult,
  EarningsTimingExpectation,
  EarningsTrackingRecord,
} from "./types";

// ===== Persistent earnings tracker =====
//
// Lifecycle: Upcoming Earnings Calendar -> "awaiting" -> "reportedAwaitingReaction"
// (actuals known, reaction not computable yet) -> "reported" (or
// "resultsUnavailable" after a grace period with no confirmed actuals) ->
// pruned from the store after RETENTION_DAYS. Identity = ticker +
// earningsDate, so the same event can never exist as two records and never
// renders as both upcoming and reported – see recordKey/upsertTrackedEarnings
// and filterOutReported below.
//
// Persistence: data/earnings-tracker.json – a normal TRACKED file (data/ is
// not in .gitignore), not the ephemeral cache/ directory and not reports/
// (which only holds generated output). GitHub Actions gives every run a
// fresh `actions/checkout`, so surviving across runs requires the file to
// actually be committed back to the repo – see the workflow's "Persist
// rolling state" step, which commits this file (and the pre-existing
// reports/performance/ ledger, which had the identical gap) after
// successful SCHEDULED runs only. This module itself is storage-location
// agnostic (loadTracker/saveTracker take an explicit path), so tests can
// point it at a temp directory without touching the real file.

export const RETENTION_DAYS = 90;
export const DISPLAY_TRADING_DAYS = 5;
export const DISPLAY_MAX_COUNT = 8;
// After this many days past the expected date with no confirmed actuals
// (Finnhub unconfigured, or reachable but genuinely has nothing), stop
// retrying every run and record it honestly as "resultsUnavailable" instead
// of leaving it "awaiting" forever. A transient Finnhub outage (down for a
// day) stays well within this window and is retried automatically on the
// very next run – see refreshTrackedEarnings below.
export const RESULTS_GRACE_DAYS = 10;

export const DEFAULT_TRACKER_FILE = path.join("data", "earnings-tracker.json");

export function loadTracker(filePath: string = DEFAULT_TRACKER_FILE): EarningsTrackingRecord[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as EarningsTrackingRecord[]) : [];
  } catch {
    return []; // a corrupt store should never crash a run
  }
}

export function saveTracker(records: EarningsTrackingRecord[], filePath: string = DEFAULT_TRACKER_FILE): string {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
  return filePath;
}

export function recordKey(ticker: string, earningsDate: string): string {
  return `${ticker}|${earningsDate}`;
}

// ===== Section 1: persist upcoming earnings, deduped by ticker+date =====
export function upsertTrackedEarnings(
  records: EarningsTrackingRecord[],
  entries: EarningsCalendarEntry[],
  nowTimestampIso: string
): EarningsTrackingRecord[] {
  const byKey = new Map(records.map((r) => [recordKey(r.ticker, r.earningsDate), r]));
  for (const e of entries) {
    const key = recordKey(e.ticker, e.reportDate);
    const existing = byKey.get(key);
    if (existing) {
      // Only refreshes lastSeenAt / expected (pre-report) fields – NEVER
      // touches `status` or `result`, so a record that already progressed
      // to reportedAwaitingReaction/reported/resultsUnavailable can never
      // be reset back to "awaiting" just because the calendar still (or
      // again) lists it for a day or two.
      existing.lastSeenAt = nowTimestampIso;
      if (e.estimatedEps !== undefined) existing.expectedEps = e.estimatedEps;
      if (e.estimatedRevenue !== undefined) existing.expectedRevenue = e.estimatedRevenue;
      if (e.timeOfDay) existing.expectedTiming = e.timeOfDay;
    } else {
      byKey.set(key, {
        ticker: e.ticker,
        name: e.name,
        earningsDate: e.reportDate,
        expectedTiming: e.timeOfDay ?? "unknown",
        expectedEps: e.estimatedEps,
        expectedRevenue: e.estimatedRevenue,
        firstSeenAt: nowTimestampIso,
        lastSeenAt: nowTimestampIso,
        status: "awaiting",
      });
    }
  }
  return Array.from(byKey.values());
}

// ===== Section 7: reported events must disappear from Upcoming Earnings.
// Both "reportedAwaitingReaction" and "reported" mean actual results are
// CONFIRMED – the reaction being pending doesn't make it any less reported,
// so both statuses are filtered out here. =====
export function filterOutReported(
  entries: EarningsCalendarEntry[],
  records: EarningsTrackingRecord[]
): EarningsCalendarEntry[] {
  const reportedKeys = new Set(
    records
      .filter((r) => r.status === "reported" || r.status === "reportedAwaitingReaction")
      .map((r) => recordKey(r.ticker, r.earningsDate))
  );
  return entries.filter((e) => !reportedKeys.has(recordKey(e.ticker, e.reportDate)));
}

function pickClosestRow(rows: EarningsResultRow[], expectedDateIso: string): EarningsResultRow | null {
  let best: EarningsResultRow | null = null;
  let bestDiff = Infinity;
  for (const r of rows) {
    const diff = Math.abs(daysBetweenIso(expectedDateIso, r.date));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return best;
}

function toDisplayTiming(t: EarningsTimingExpectation | undefined): "pre-market" | "post-market" | undefined {
  return t === "pre-market" || t === "post-market" ? t : undefined;
}

// Injectable so tests can simulate Finnhub/Yahoo responses deterministically
// (outage, partial data, full data) without any network access. Production
// code never passes these – the defaults in runEarningsTracker below wire
// the real dataSources-backed providers.
export type ResultsFetcher = (ticker: string, aroundDateIso: string) => Promise<SourcedValue<EarningsResultRow[]>>;
export type ClosesFetcher = (ticker: string) => Promise<SourcedValue<DatedClose[]>>;

function buildResult(
  matched: EarningsResultRow,
  rec: EarningsTrackingRecord,
  reaction: EarningsReaction | null,
  nowTimestampIso: string
): EarningsResult {
  const epsSurprisePct = computeSurprisePct(matched.epsActual, matched.epsEstimate ?? rec.expectedEps);
  const revenueSurprisePct = computeSurprisePct(matched.revenueActual, matched.revenueEstimate ?? rec.expectedRevenue);
  const epsStatus: EarningsFigureStatus = matched.epsActual !== undefined ? "available" : "unavailable";
  const revenueStatus: EarningsFigureStatus = matched.revenueActual !== undefined ? "available" : "unavailable";
  return {
    status: "available",
    reportedDate: matched.date,
    reportedTiming: matched.timeOfDay ?? rec.expectedTiming,
    actualEps: matched.epsActual,
    expectedEpsAtReport: matched.epsEstimate ?? rec.expectedEps,
    epsSurprisePct,
    actualRevenue: matched.revenueActual,
    expectedRevenueAtReport: matched.revenueEstimate ?? rec.expectedRevenue,
    revenueSurprisePct,
    reaction,
    interpretation: buildInterpretation({ epsStatus, epsSurprisePct, revenueStatus, revenueSurprisePct, reaction }),
    checkedAt: nowTimestampIso,
  };
}

// ===== Sections 2/3/5: detect reported earnings, fetch actuals, compute
// reaction + interpretation. Section 4 (timing correctness): a result is
// NEVER marked fully "reported" before the required regular-session closing
// price actually exists – see the reportedAwaitingReaction branch, which
// keeps retrying ONLY the reaction (actual figures are already known and
// aren't re-fetched) on every subsequent run until computeEarningsReaction
// stops returning null. Section 7: transitions awaiting ->
// reportedAwaitingReaction/reported -> (or resultsUnavailable). =====
export async function refreshTrackedEarnings(
  records: EarningsTrackingRecord[],
  opts: {
    now: Date;
    onProgress?: (msg: string) => void;
    fetchResults?: ResultsFetcher;
    fetchCloses?: ClosesFetcher;
  }
): Promise<EarningsTrackingRecord[]> {
  const { now, onProgress = () => {} } = opts;
  const fetchResults: ResultsFetcher = opts.fetchResults ?? ((ticker, date) => getFinnhubEarningsResult(ticker, date, onProgress));
  const fetchCloses: ClosesFetcher = opts.fetchCloses ?? ((ticker) => getYahooDailyClosesWithDates(ticker, onProgress));
  const nowIso = usMarketDateIso(now);
  const nowTimestampIso = now.toISOString();

  const updated: EarningsTrackingRecord[] = [];
  for (const rec of records) {
    // Actual figures already confirmed – only the reaction is still
    // outstanding. Re-fetch closes (cheap, unbudgeted) and retry the
    // reaction calc; never re-hit the results provider for this record
    // again, its figures don't change.
    if (rec.status === "reportedAwaitingReaction" && rec.result) {
      onProgress(`   re-checking stock reaction for ${rec.ticker} (reported ${rec.result.reportedDate ?? rec.earningsDate})...`);
      const closesRes = await fetchCloses(rec.ticker);
      const reaction = computeEarningsReaction(
        closesRes.value,
        rec.result.reportedDate ?? rec.earningsDate,
        rec.result.reportedTiming ?? rec.expectedTiming
      );
      if (!reaction) {
        updated.push({ ...rec, lastSeenAt: nowTimestampIso }); // still awaiting the next session's close
        continue;
      }
      const epsStatus: EarningsFigureStatus = rec.result.actualEps !== undefined ? "available" : "unavailable";
      const revenueStatus: EarningsFigureStatus = rec.result.actualRevenue !== undefined ? "available" : "unavailable";
      updated.push({
        ...rec,
        lastSeenAt: nowTimestampIso,
        status: "reported",
        result: {
          ...rec.result,
          reaction,
          interpretation: buildInterpretation({
            epsStatus,
            epsSurprisePct: rec.result.epsSurprisePct,
            revenueStatus,
            revenueSurprisePct: rec.result.revenueSurprisePct,
            reaction,
          }),
          checkedAt: nowTimestampIso,
        },
      });
      continue;
    }

    const duePastOrToday = daysBetweenIso(rec.earningsDate, nowIso) >= 0;
    if (rec.status !== "awaiting" || !duePastOrToday) {
      updated.push(rec);
      continue;
    }

    onProgress(`   checking earnings result for ${rec.ticker} (expected ${rec.earningsDate})...`);
    const resultRes = await fetchResults(rec.ticker, rec.earningsDate);
    const rows = resultRes.value ?? [];
    const matched = pickClosestRow(rows, rec.earningsDate);
    const hasActuals = matched && (matched.epsActual !== undefined || matched.revenueActual !== undefined);

    if (!hasActuals) {
      // Covers BOTH a genuine "not yet reported" AND a transient provider
      // outage (Finnhub down / unreachable this run) identically: the
      // record simply stays "awaiting" and is retried next run. It is
      // NEVER discarded. Only after RESULTS_GRACE_DAYS with still nothing
      // does it stop being retried daily and get recorded as
      // "resultsUnavailable" (still retained, just no longer re-checked
      // every run).
      const daysPastExpected = daysBetweenIso(rec.earningsDate, nowIso);
      if (daysPastExpected > RESULTS_GRACE_DAYS) {
        updated.push({
          ...rec,
          lastSeenAt: nowTimestampIso,
          status: "resultsUnavailable",
          result: { status: "unavailable", checkedAt: nowTimestampIso },
        });
      } else {
        updated.push({ ...rec, lastSeenAt: nowTimestampIso });
      }
      continue;
    }

    const reportedTiming: EarningsTimingExpectation = matched!.timeOfDay ?? rec.expectedTiming;
    const closesRes = await fetchCloses(rec.ticker);
    const reaction = computeEarningsReaction(closesRes.value, matched!.date, reportedTiming);
    const result = buildResult(matched!, rec, reaction, nowTimestampIso);

    // Section 4: never mark fully "reported" before the required
    // regular-session close actually exists.
    const newStatus = reaction ? "reported" : "reportedAwaitingReaction";
    updated.push({ ...rec, lastSeenAt: nowTimestampIso, status: newStatus, result });
  }
  return updated;
}

// ===== Section 6: 90-day retention – keep history, but only ever prune here
// (the DISPLAY window below is separate and much narrower). =====
export function pruneOldRecords(
  records: EarningsTrackingRecord[],
  nowIso: string,
  retentionDays = RETENTION_DAYS
): EarningsTrackingRecord[] {
  return records.filter((r) => daysBetweenIso(r.earningsDate, nowIso) <= retentionDays);
}

// ===== Section 6: display window – last 5 trading days, capped at 8 =====
//
// "Trading days ago" is approximated from the calendar-day gap (same ~5/7
// weekday ratio already used by this codebase's other coarse trading-day
// estimates) – a display-ordering heuristic, not the reaction calculation
// itself (which uses real per-ticker Yahoo trading days, see
// earningsReaction.ts).
export function selectDisplayRecords(
  reported: EarningsTrackingRecord[],
  nowIso: string
): EarningsTrackingRecord[] {
  const withAge = reported
    .map((r) => ({ r, daysAgo: daysBetweenIso(r.result?.reportedDate ?? r.earningsDate, nowIso) }))
    .filter(({ daysAgo }) => daysAgo >= 0 && Math.round((daysAgo * 5) / 7) <= DISPLAY_TRADING_DAYS);
  withAge.sort((a, b) => a.daysAgo - b.daysAgo);
  return withAge.slice(0, DISPLAY_MAX_COUNT).map((x) => x.r);
}

export interface EarningsTrackerRunResult {
  entries: EarningsFollowUpEntry[];
  status: EarningsFollowUpStatus;
  coverage: EarningsFollowUpCoverage;
  records: EarningsTrackingRecord[]; // full updated set – pipeline.ts uses this to filter the Upcoming Earnings Calendar (section 7)
}

// Single entry point pipeline.ts uses: load -> upsert (section 1) -> refresh
// (sections 2/3/4/5/7) -> prune (section 6) -> save -> derive the rendered
// section + diagnostics (section 8).
export async function runEarningsTracker(opts: {
  filePath?: string;
  now: Date;
  upcomingEntries: EarningsCalendarEntry[];
  onProgress?: (msg: string) => void;
  fetchResults?: ResultsFetcher;
  fetchCloses?: ClosesFetcher;
}): Promise<EarningsTrackerRunResult> {
  const { filePath = DEFAULT_TRACKER_FILE, now, upcomingEntries, onProgress = () => {}, fetchResults, fetchCloses } = opts;
  const nowIso = usMarketDateIso(now);
  const nowTimestampIso = now.toISOString();

  let records = loadTracker(filePath);
  records = upsertTrackedEarnings(records, upcomingEntries, nowTimestampIso);
  records = await refreshTrackedEarnings(records, { now, onProgress, fetchResults, fetchCloses });
  records = pruneOldRecords(records, nowIso);
  saveTracker(records, filePath);

  // Both "reported" (fully complete) and "reportedAwaitingReaction" (actual
  // figures known, reaction pending) are shown – the renderer already shows
  // "Not yet available" for a null reaction, so the reader sees the real
  // EPS/revenue beat/miss immediately rather than waiting for the reaction.
  const reportedRecords = records.filter(
    (r) => (r.status === "reported" || r.status === "reportedAwaitingReaction") && r.result
  );
  const display = selectDisplayRecords(reportedRecords, nowIso);

  const entries: EarningsFollowUpEntry[] = display.map((r) => ({
    ticker: r.ticker,
    name: r.name,
    reportDate: r.result!.reportedDate ?? r.earningsDate,
    daysAgo: daysBetweenIso(r.result!.reportedDate ?? r.earningsDate, nowIso),
    timeOfDay: toDisplayTiming(r.result!.reportedTiming),
    result: r.result!,
  }));

  const coverage: EarningsFollowUpCoverage = {
    tracked: records.length,
    awaiting: records.filter((r) => r.status === "awaiting").length,
    resultsFound: records.filter((r) => r.status === "reported" || r.status === "reportedAwaitingReaction").length,
    resultsUnavailable: records.filter((r) => r.status === "resultsUnavailable").length,
    reactionsCalculated: records.filter((r) => r.status === "reported" && r.result?.reaction).length,
  };

  // Tri-state, same discipline as the forward calendar's status: "confirmed"
  // when there's real recent data to show; "unavailable" when there's at
  // least one OVERDUE record (expected date already passed or is today)
  // that we structurally can't verify (Finnhub not configured) – never
  // confused with a genuine "nothing reported recently", and never
  // triggered by records that simply aren't due yet; "noneFound" otherwise.
  const overdueAwaiting = records.some(
    (r) => r.status === "awaiting" && daysBetweenIso(r.earningsDate, nowIso) >= 0
  );
  let status: EarningsFollowUpStatus;
  if (entries.length > 0) {
    status = "confirmed";
  } else if (!process.env.FINNHUB_API_KEY && overdueAwaiting) {
    status = "unavailable";
  } else {
    status = "noneFound";
  }

  return { entries, status, coverage, records };
}
