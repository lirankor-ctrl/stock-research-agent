// Deterministic unit tests for the Bollinger engine – synthetic data only,
// no network.
//
//   npm run bollinger:selftest
import fs from "fs";
import os from "os";
import path from "path";
import { loadReportState, parseReportState, saveReportState } from "../reportState";
import { isEarningsSeasonDate, newsletterSectionOrder } from "../reportPresentation";
import { isUsTradingDay } from "../marketCalendar";
import { rsi as legacyRsi } from "../technicals";
import { NewsItem } from "../types";
import { lastCompletedSession, normalizeSeries, RawOhlcv } from "./data";
import { atrSeries, computeSnapshots, percentileRank, rsiSeries } from "./indicators";
import { renderBollingerHtml, renderBollingerMarkdown, renderBollingerText } from "./render";
import { analyseSeries, isMateriallyNew, MIN_RISK_REWARD, selectOpportunity } from "./scan";
import { assessNewsRisk, MIN_SELECTION_SCORE, scoreOpportunity } from "./scoring";
import { detectSetup } from "./signals";
import { BollingerCandidate, BollingerReport, DailyBar, EMPTY_BOLLINGER_REPORT, PriceSeries } from "./types";
import { BOLLINGER_TITLE, NO_PICK_TITLE } from "./view";
import { buildTechnicalPlan } from "./research";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${msg}`);
  }
}

const near = (a: number | null | undefined, b: number, eps = 1e-6) => a !== null && a !== undefined && Math.abs(a - b) <= eps;

// ---------- synthetic fixtures ----------

function tradingDates(n: number, start = "2024-06-03"): string[] {
  const out: string[] = [];
  let d = new Date(`${start}T12:00:00Z`);
  while (out.length < n) {
    const iso = d.toISOString().slice(0, 10);
    if (isUsTradingDay(iso)) out.push(iso);
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}

function makeBars(closes: number[], volumes?: number[]): DailyBar[] {
  const dates = tradingDates(closes.length);
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return {
      date: dates[i],
      open: o,
      high: Math.max(o, c) * 1.004,
      low: Math.min(o, c) * 0.996,
      close: c,
      rawClose: c,
      volume: volumes?.[i] ?? 2_000_000,
    };
  });
}

function seriesOf(bars: DailyBar[], overrides: Partial<PriceSeries> = {}): PriceSeries {
  return {
    symbol: "TEST",
    name: "Test Corp",
    exchange: "NMS",
    instrumentType: "EQUITY",
    currency: "USD",
    bars,
    adjustment: "split+dividend",
    quote: { price: bars[bars.length - 1].close, timeIso: "2026-10-07T20:00:00.000Z" },
    ...overrides,
  };
}

// Deterministic wiggle (no Math.random): an uptrend with ±amp oscillation.
function trend(n: number, start: number, dailyDrift: number, amp: number, phase = 0): number[] {
  return Array.from({ length: n }, (_, i) => start * (1 + dailyDrift) ** i * (1 + amp * Math.sin((i + phase) * 1.7)));
}

// Squeeze then confirmed breakout: a year of normal volatility, ~3 weeks of
// unusually tight range, then a high-volume close above the upper band.
function squeezeBreakoutCloses(): { closes: number[]; volumes: number[] } {
  const base = trend(260, 50, 0.0015, 0.02);
  const last = base[base.length - 1];
  const tight = Array.from({ length: 22 }, (_, i) => last * (1 + 0.006 * Math.sin(i * 1.7)));
  const closes = [...base, ...tight, last * 1.025];
  const volumes = closes.map((_, i) => (i === closes.length - 1 ? 6_000_000 : 2_000_000));
  return { closes, volumes };
}

// Uptrend, then a sharp 6-session slide through the lower band.
function slideCloses(): number[] {
  const base = trend(260, 50, 0.0015, 0.01);
  let p = base[base.length - 1];
  const slide = Array.from({ length: 6 }, () => (p = p * 0.965));
  return [...base, ...slide];
}

function candidateFrom(series: PriceSeries): BollingerCandidate {
  const res = analyseSeries(series, series.bars[series.bars.length - 1].date);
  if (!res.candidate) throw new Error(`fixture produced no candidate (${res.reject})`);
  return res.candidate;
}

function withScore(c: BollingerCandidate, total: number, symbol = c.symbol): BollingerCandidate {
  return { ...c, symbol, score: { ...c.score, total }, enriched: true };
}

// ---------- 1. Indicator math ----------

function testIndicators(): void {
  const bars = makeBars(Array.from({ length: 20 }, (_, i) => i + 1));
  const s = computeSnapshots(bars)[19]!;
  const sd = Math.sqrt((20 * 20 - 1) / 12); // population σ of 1..20
  assert(near(s.sma20, 10.5), "SMA20 of 1..20 is 10.5");
  assert(near(s.upper, 10.5 + 2 * sd) && near(s.lower, 10.5 - 2 * sd), "upper/lower = SMA ± 2·population σ");
  assert(near(s.bandwidth, (4 * sd) / 10.5), "bandwidth = (upper − lower) / SMA20");
  assert(near(s.percentB, (20 - s.lower) / (s.upper - s.lower)), "%B = (close − lower) / (upper − lower)");
  assert(computeSnapshots(bars)[18] === null, "no snapshot before 20 sessions exist (not padded)");
  assert(s.ma50 === null && s.ma200 === null, "MA50/MA200 are null with insufficient history (never a short-slice average)");
  assert(s.bandwidthPercentile === null, "bandwidth percentile is null with too little history");

  const flat = computeSnapshots(makeBars(Array(25).fill(100)))[24]!;
  assert(flat.upper === 100 && flat.lower === 100 && flat.bandwidth === 0 && flat.percentB === 0.5, "constant prices → zero-width bands, %B 0.5 (no divide-by-zero)");

  const pr = percentileRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 9, 252, 5);
  assert(pr.pct === 100 && pr.count === 10, "percentile rank of the window maximum is 100");
  assert(percentileRank([5, 4, 3, 2, 1], 4, 252, 5).pct === 20, "percentile rank of the window minimum is 1/n");
  assert(percentileRank([1, 2, 3], 2, 252, 5).pct === null, "percentile is null below the minimum history");

  const closes = trend(120, 40, 0.001, 0.03);
  const series = rsiSeries(closes);
  assert(near(series[119], legacyRsi(closes) as number, 1e-9), "RSI(14) series matches the existing technicals.ts Wilder RSI");
  assert(rsiSeries(Array.from({ length: 30 }, (_, i) => i + 1))[29] === 100, "monotonic gains → RSI 100");

  const vols = [...Array(20).fill(1_000_000), 3_000_000];
  const rv = computeSnapshots(makeBars(Array.from({ length: 21 }, (_, i) => 100 + i), vols))[20]!;
  assert(near(rv.relVolume, 3), "relative volume compares to the PRIOR 20 sessions (today excluded from its own baseline)");

  const rangeBars: DailyBar[] = makeBars(Array(30).fill(100)).map((b) => ({ ...b, open: 100, high: 101, low: 99 }));
  assert(near(atrSeries(rangeBars)[29], 2), "ATR(14) of a constant 2-point range is 2");
}

// ---------- 2. Look-ahead / session alignment ----------

function testNoLookAhead(): void {
  const { closes, volumes } = squeezeBreakoutCloses();
  const full = computeSnapshots(makeBars(closes, volumes));
  const cut = 240;
  const partial = computeSnapshots(makeBars(closes.slice(0, cut), volumes.slice(0, cut)));
  const same = partial.every((p, i) => JSON.stringify(p) === JSON.stringify(full[i]));
  assert(same, "appending future sessions never changes any earlier snapshot (no look-ahead in any indicator)");

  // Session calendar.
  assert(lastCompletedSession(new Date("2026-10-08T12:58:00Z")) === "2026-10-07", "pre-market Thursday → last completed session is Wednesday");
  assert(lastCompletedSession(new Date("2026-10-08T21:30:00Z")) === "2026-10-08", "after the close → today's session is complete");
  assert(lastCompletedSession(new Date("2026-10-08T15:00:00Z")) === "2026-10-07", "during the session → today's in-progress bar is NOT complete");
  assert(lastCompletedSession(new Date("2026-10-10T15:00:00Z")) === "2026-10-09", "Saturday → Friday");
  assert(lastCompletedSession(new Date("2026-10-12T12:00:00Z")) === "2026-10-09", "Monday pre-market → previous Friday");
  assert(lastCompletedSession(new Date("2026-09-07T16:00:00Z")) === "2026-09-04", "Labor Day (holiday) → previous trading day");

  // Normalization drops in-progress and future bars, and null rows.
  const raw: RawOhlcv = {
    symbol: "TEST",
    fetchedAt: "2026-10-08T15:00:00.000Z", // fetched DURING Thursday's session
    meta: { instrumentType: "EQUITY", currency: "USD", exchange: "NMS" },
    hasAdjClose: true,
    rows: [
      { date: "2026-10-06", open: 10, high: 11, low: 9, close: 10, adjClose: 9.5, volume: 100 },
      { date: "2026-10-07", open: 10, high: 12, low: 10, close: 11, adjClose: 11, volume: 100 },
      { date: "2026-10-07", open: 10, high: 12, low: 10, close: 11.5, adjClose: 11.5, volume: 120 },
      { date: "2026-10-05", open: null, high: 11, low: 9, close: 10, adjClose: 10, volume: 100 },
      { date: "2026-10-08", open: 11, high: 13, low: 11, close: 12, adjClose: 12, volume: 50 },
    ],
  };
  const norm = normalizeSeries(raw, new Date("2026-10-09T12:00:00Z"));
  assert(!norm.bars.some((b) => b.date === "2026-10-08"), "a bar cached mid-session is dropped even when read the next day (unsettled at fetch time)");
  assert(!norm.bars.some((b) => b.date === "2026-10-05"), "rows with missing OHLC values are dropped, never filled in");
  assert(norm.bars.length === 2 && norm.bars[0].date < norm.bars[1].date, "bars are de-duplicated by date and sorted oldest first");
  assert(norm.bars[1].close === 11.5, "a duplicate session keeps the latest row");
  const b0 = norm.bars[0];
  assert(near(b0.close, 9.5) && near(b0.high, 11 * 0.95) && near(b0.low, 9 * 0.95) && b0.rawClose === 10, "adjustment factor (adjclose/close) is applied to O/H/L/C together; raw close preserved");
  assert(normalizeSeries({ ...raw, hasAdjClose: false }, new Date("2026-10-09T12:00:00Z")).adjustment === "split-only", "series without adjclose is flagged split-only, not silently mixed");
  const laterQuote = { ...raw, meta: { ...raw.meta, price: 99, priceTime: Date.parse("2026-10-12T20:00:00Z") / 1000 } };
  assert(normalizeSeries(laterQuote, new Date("2026-10-09T12:00:00Z")).quote === null, "a quote stamped after 'now' is never displayed (no look-ahead in replays)");
  assert(normalizeSeries(laterQuote, new Date("2026-10-13T12:00:00Z")).quote?.price === 99, "a quote from before 'now' is displayed with its own timestamp");
}

// ---------- 3. Filters / missing data ----------

function testFiltersAndMissingData(): void {
  const { closes, volumes } = squeezeBreakoutCloses();
  const bars = makeBars(closes, volumes);
  const lastDate = bars[bars.length - 1].date;
  assert(analyseSeries(seriesOf(bars), lastDate).candidate !== null, "a liquid, fresh, US-listed equity with a setup becomes a candidate");
  assert(analyseSeries(seriesOf(bars), "2099-01-01").reject === "stale", "a series whose last bar is not the expected session is rejected as stale");
  assert(analyseSeries(seriesOf(bars, { instrumentType: "ETF" }), lastDate).reject === "nonEquity", "ETFs are excluded");
  assert(analyseSeries(seriesOf(bars, { exchange: "PNK" }), lastDate).reject === "nonEquity", "OTC (Pink) listings are excluded");
  assert(analyseSeries(seriesOf(bars, { symbol: "ABCDW" }), lastDate).reject === "nonEquity", "warrant tickers are excluded");
  assert(analyseSeries(seriesOf(bars.slice(-40)), lastDate).reject === "insufficientHistory", "too little history is rejected, not extrapolated");
  const penny = makeBars(closes.map((c) => c / 10), volumes.map((v) => v * 10));
  assert(analyseSeries(seriesOf(penny), penny[penny.length - 1].date).reject === "illiquid", "sub-$10 stocks are excluded");
  const thin = makeBars(closes, closes.map(() => 50_000));
  assert(analyseSeries(seriesOf(thin), thin[thin.length - 1].date).reject === "illiquid", "low dollar-volume stocks are excluded");
}

// ---------- 4. Signal detection ----------

function testSignals(): void {
  const { closes, volumes } = squeezeBreakoutCloses();
  const c = candidateFrom(seriesOf(makeBars(closes, volumes)));
  assert(c.signal.type === "squeeze" && c.signal.status === "confirmed", "tight bands then a high-volume close above the upper band → CONFIRMED squeeze breakout");

  const weakVol = volumes.map(() => 2_000_000);
  const weak = candidateFrom(seriesOf(makeBars(closes, weakVol)));
  assert(weak.signal.status === "emerging", "the same breakout without volume confirmation is only EMERGING");

  const sqOnly = analyseSeries(seriesOf(makeBars(closes.slice(0, -1), volumes.slice(0, -1))), makeBars(closes.slice(0, -1))[closes.length - 2].date);
  assert(sqOnly.candidate?.signal.type === "squeeze" && sqOnly.candidate.signal.status === "emerging", "narrow bands without a breakout → EMERGING squeeze, not a signal");

  const slide = slideCloses();
  const touching = candidateFrom(seriesOf(makeBars(slide)));
  assert(touching.signal.type === "meanReversion" && touching.signal.status === "emerging", "closing below the lower band is NOT a buy signal – only an emerging mean-reversion setup");

  const p = slide[slide.length - 1];
  const recovered = [...slide, p * 1.045];
  const recVol = recovered.map((_, i) => (i === recovered.length - 1 ? 3_000_000 : 2_000_000));
  const rec = candidateFrom(seriesOf(makeBars(recovered, recVol)));
  assert(rec.signal.type === "meanReversion" && rec.signal.status === "confirmed", "recovery back inside the band, above the prior high, RSI turning up, with volume → CONFIRMED mean reversion");
  const recNoVol = candidateFrom(seriesOf(makeBars(recovered, recovered.map(() => 1_000_000).map((v, i, a) => (i === a.length - 1 ? 500_000 : 2_000_000)))));
  assert(recNoVol.signal.status === "emerging", "the same recovery on below-average volume stays EMERGING");

  assert(detectSetup([c.history[0]]) === null, "fewer than two sessions of history → no setup (never guessed)");
}

// ---------- 5. Scoring ----------

function testScoring(): void {
  const { closes, volumes } = squeezeBreakoutCloses();
  const c = candidateFrom(seriesOf(makeBars(closes, volumes)));
  const input = { snapshot: c.snapshot, signal: c.signal, isFresh: true, barCount: 283, hasFundamentals: true, newsRisk: null };
  const a = scoreOpportunity(input);
  const b = scoreOpportunity(input);
  assert(JSON.stringify(a) === JSON.stringify(b), "scoring is deterministic");
  assert(a.total >= 0 && a.total <= 100, "score is bounded 0..100");
  assert(a.components.reduce((s, k) => s + k.max, 0) === 100, "component maxima sum to exactly 100 (transparent weights)");
  assert(scoreOpportunity({ ...input, isFresh: false }).total < a.total, "stale data lowers the score");
  assert(scoreOpportunity({ ...input, riskReward: 0.6 }).total < a.total, "risk/reward below 1 is penalized");
  const emerging = scoreOpportunity({ ...input, signal: { ...c.signal, status: "emerging" } });
  assert(emerging.total < a.total, "an emerging setup scores below the same confirmed setup");

  const news = (title: string): NewsItem => ({ title, url: "https://example.com", source: "Reuters", publishedAt: "20261007T120000" });
  assert(assessNewsRisk({ news: null, daysToEarnings: null }).points === 5, "unavailable news is neutral (5/10) – never assumed positive");
  const clean = assessNewsRisk({ news: [news("Test Corp wins major contract")], daysToEarnings: null }).points;
  const bad = assessNewsRisk({ news: [news("Test Corp faces SEC investigation"), news("Analyst downgrades Test Corp")], daysToEarnings: null }).points;
  assert(bad < clean, "negative material headlines (investigation, downgrade) lower the news/risk score");
  assert(assessNewsRisk({ news: [], daysToEarnings: 3 }).points < assessNewsRisk({ news: [], daysToEarnings: null }).points, "earnings within 7 days is penalized as binary-event risk");
}

// ---------- 6. Ranking / selection ----------

function testSelection(): void {
  const { closes, volumes } = squeezeBreakoutCloses();
  const base = candidateFrom(seriesOf(makeBars(closes, volumes)));
  assert((buildTechnicalPlan(base).riskReward ?? 0) >= MIN_RISK_REWARD, "fixture breakout has an honest R/R ≥ 1 (target above trigger, stop below)");
  const A = withScore(base, 80, "AAA");
  const B = withScore(base, 72, "BBB");
  const low = withScore(base, MIN_SELECTION_SCORE - 1, "LOW");
  const emerging = { ...withScore(base, 95, "EMG"), signal: { ...base.signal, status: "emerging" as const } };

  assert(selectOpportunity([A, B], null, "2026-10-08").selected?.symbol === "AAA", "the highest-scoring qualifying candidate is selected");
  const none = selectOpportunity([low], null, "2026-10-08");
  assert(none.selected === null && !!none.noneReasonHebrew, "nothing above the threshold → no pick, with an explicit reason (never forced)");
  assert(selectOpportunity([emerging, B], null, "2026-10-08").selected?.symbol === "BBB", "an emerging setup is never selected, however high it scores");
  const w = base.snapshot.upper - base.snapshot.lower;
  const stretched = { ...withScore(base, 95, "EXT"), snapshot: { ...base.snapshot, close: base.snapshot.sma20 + 2 * w } };
  assert((buildTechnicalPlan(stretched).riskReward ?? 9) < MIN_RISK_REWARD, "a breakout stretched far above the band has R/R < 1 by construction");
  assert(selectOpportunity([stretched, B], null, "2026-10-08").selected?.symbol === "BBB", "a high-scoring setup with R/R < 1 is not selected");

  const last = { ticker: "AAA", tradingDate: "2026-10-07", setupType: A.signal.type, status: "confirmed" as const };
  const avoided = selectOpportunity([A, B], last, "2026-10-08");
  assert(avoided.selected?.symbol === "BBB" && !!avoided.repeatNoteHebrew, "yesterday's company with the same signal is skipped for the next QUALIFYING candidate");
  const onlyRepeat = selectOpportunity([A, low], last, "2026-10-08");
  assert(onlyRepeat.selected === null, "no below-threshold backfill for variety – if only the repeat qualifies, the result is 'none'");
  const newSignal = { ...last, setupType: "meanReversion" as const };
  assert(isMateriallyNew(A, newSignal) && selectOpportunity([A, B], newSignal, "2026-10-08").selected?.symbol === "AAA", "a materially new signal type allows repeating the company");
  assert(selectOpportunity([A, B], { ...last, tradingDate: "2026-10-08" }, "2026-10-08").selected?.symbol === "AAA", "a same-day re-run keeps the same pick (repeat rule applies across days only)");
  assert(selectOpportunity([A, B], { ...last, tradingDate: "2026-09-20" }, "2026-10-08").selected?.symbol === "AAA", "an old pick outside the repeat window does not block selection");
}

// ---------- 7. Rendering / presentation ----------

function testRendering(): void {
  const none: BollingerReport = { ...EMPTY_BOLLINGER_REPORT, status: "none", noneReasonHebrew: "סיבה", minScore: MIN_SELECTION_SCORE };
  const html = renderBollingerHtml(none);
  assert(html.includes(NO_PICK_TITLE) && renderBollingerMarkdown(none).includes(NO_PICK_TITLE) && renderBollingerText(none).includes(NO_PICK_TITLE), "'No high-confidence Bollinger opportunity today' renders on every surface");
  assert(html.includes(BOLLINGER_TITLE) && (html.match(/bollinger-card/g) ?? []).length === 1, "section title + exactly one card in the no-pick state");

  const { closes, volumes } = squeezeBreakoutCloses();
  const c = withScore(candidateFrom(seriesOf(makeBars(closes, volumes))), 80, "SQZ");
  const plan = buildTechnicalPlan(c);
  const report: BollingerReport = {
    ...EMPTY_BOLLINGER_REPORT,
    status: "selected",
    minScore: MIN_SELECTION_SCORE,
    pick: {
      candidate: c,
      research: { profileSource: { source: "unavailable" }, news: [], newsSource: { source: "unavailable" } },
      plan,
      signalExplanationHebrew: "הסבר",
      trendHebrew: "מגמה",
      bullishHebrew: "שורי",
      bearishHebrew: "דובי",
      risksHebrew: ["סיכון"],
      catalystsHebrew: ["קטליזטור"],
    },
  };
  const out = [renderBollingerHtml(report), renderBollingerMarkdown(report), renderBollingerText(report)];
  assert(out.every((o) => o.includes("SQZ")), "the selected ticker renders on HTML, Markdown and text");
  assert(out[0].includes("לא זמין") && !out[0].includes("undefined") && !out[0].includes("NaN"), "missing fundamentals render as 'לא זמין' – never undefined/NaN");
  assert(out[0].includes("ספק החדשות לא היה זמין"), "unavailable news is stated explicitly, not presented as 'no news'");
}

// ---------- 8. Layout: earnings-season prominence ----------

function testSectionOrder(): void {
  assert(!isEarningsSeasonDate("2026-10-08") && isEarningsSeasonDate("2026-10-20") && isEarningsSeasonDate("2026-11-25") && !isEarningsSeasonDate("2026-12-01"), "earnings-season windows are date-deterministic");
  const off = newsletterSectionOrder({ generatedAt: "2026-10-08T13:00:00Z", earningsCalendar: [] });
  const on = newsletterSectionOrder({ generatedAt: "2026-10-20T13:00:00Z", earningsCalendar: [] });
  assert(off[0] === "bollinger" && on[0] === "bollinger", "Bollinger Opportunity is the lead section in and out of season");
  assert(off.indexOf("earningsCalendar") > off.indexOf("topOpportunities"), "outside earnings season the earnings calendar moves below the research sections");
  assert(on.indexOf("earningsCalendar") === 1, "in earnings season the earnings calendar keeps its prominent slot");
  assert(off.length === 14 && new Set(off).size === 14 && on.length === 14, "no section is dropped by the re-ordering");
}

// ---------- 9. Anti-repeat state persistence ----------

function testState(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bollinger-state-"));
  const file = path.join(dir, "report-state.json");
  const pick = { ticker: "AAA", tradingDate: "2026-10-07", setupType: "squeeze" as const, status: "confirmed" as const };
  saveReportState({ ...parseReportState(null), lastBollingerPick: pick }, file);
  assert(JSON.stringify(loadReportState(file).lastBollingerPick) === JSON.stringify(pick), "the last Bollinger pick round-trips through data/report-state.json");
  assert(parseReportState('{"lastSentUsTradingDate":"2026-10-07"}').lastBollingerPick === null, "older state files without a pick read as 'no previous pick'");
  assert(parseReportState('{"lastBollingerPick":{"ticker":"X","tradingDate":"2026-10-07","setupType":"bogus"}}').lastBollingerPick === null, "a malformed pick record is ignored, not trusted");
  fs.rmSync(dir, { recursive: true, force: true });
}

testIndicators();
testNoLookAhead();
testFiltersAndMissingData();
testSignals();
testScoring();
testSelection();
testRendering();
testSectionOrder();
testState();
console.log(process.exitCode ? "\n💥 bollinger self-test FAILED" : "\n🎉 bollinger self-test PASSED");
