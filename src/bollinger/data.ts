// Daily OHLCV for the Bollinger scan – Yahoo Finance chart endpoint (no key,
// not part of the Alpha Vantage budget), cached on disk.
//
// ===== Adjustment =====
// Yahoo's OHLC are split-adjusted; `adjclose` is split+dividend adjusted. The
// engine uses ONE basis for everything: factor = adjclose / close per bar,
// applied to open/high/low/close, so bands, ATR and MAs never mix adjusted
// closes with unadjusted highs/lows. Volume is Yahoo's split-adjusted volume.
// The newest bar's factor is 1 (dividend adjustment only rescales the past),
// so the levels shown in the report are in today's actual price terms. When a
// payload has no adjclose the series falls back to split-only and says so.
//
// ===== Session alignment / no look-ahead =====
// Only COMPLETED sessions are used. A bar is dropped when its date is after
// the last completed US session either at fetch time (an in-progress session
// that was cached mid-day) or now. The report runs pre-market, so the latest
// usable bar is normally the previous trading day.
import { readCache, TTL, writeCache } from "../cache";
import { usMarketDateIso } from "../dateUtils";
import { fetchYahooChart } from "../marketData";
import { isUsTradingDay } from "../marketCalendar";
import { usMarketState } from "../reportTiming";
import { SourceInfo } from "../types";
import { DailyBar, PriceSeries } from "./types";

const STALE_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface RawOhlcvRow {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  adjClose: number | null;
  volume: number | null;
}

export interface RawOhlcv {
  symbol: string;
  fetchedAt: string; // ISO – drives the unsettled-session cutoff
  meta: {
    longName?: string;
    exchange?: string;
    instrumentType?: string;
    currency?: string;
    price?: number;
    priceTime?: number; // unix seconds
    fiftyTwoWeekHigh?: number;
    fiftyTwoWeekLow?: number;
  };
  hasAdjClose: boolean;
  rows: RawOhlcvRow[];
}

function previousTradingDay(dateIso: string): string {
  let d = new Date(`${dateIso}T12:00:00Z`);
  for (let i = 0; i < 10; i++) {
    d = new Date(d.getTime() - 24 * 60 * 60 * 1000);
    const iso = d.toISOString().slice(0, 10);
    if (isUsTradingDay(iso)) return iso;
  }
  return dateIso;
}

// The most recent US session that has fully closed as of `now`.
export function lastCompletedSession(now: Date): string {
  const today = usMarketDateIso(now);
  return usMarketState(now) === "after-hours" ? today : previousTradingDay(today);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseYahooChart(symbol: string, result: any, fetchedAt: Date): RawOhlcv | null {
  const ts: unknown[] = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0] ?? {};
  const adj: unknown[] | undefined = result?.indicators?.adjclose?.[0]?.adjclose;
  const meta = result?.meta ?? {};
  const rows: RawOhlcvRow[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = num(ts[i]);
    if (t === null) continue;
    rows.push({
      date: usMarketDateIso(new Date(t * 1000)),
      open: num(q.open?.[i]),
      high: num(q.high?.[i]),
      low: num(q.low?.[i]),
      close: num(q.close?.[i]),
      adjClose: adj ? num(adj[i]) : null,
      volume: num(q.volume?.[i]),
    });
  }
  if (rows.length === 0) return null;
  return {
    symbol,
    fetchedAt: fetchedAt.toISOString(),
    meta: {
      longName: meta.longName ?? meta.shortName,
      exchange: meta.exchangeName,
      instrumentType: meta.instrumentType,
      currency: meta.currency,
      price: num(meta.regularMarketPrice) ?? undefined,
      priceTime: num(meta.regularMarketTime) ?? undefined,
      fiftyTwoWeekHigh: num(meta.fiftyTwoWeekHigh) ?? undefined,
      fiftyTwoWeekLow: num(meta.fiftyTwoWeekLow) ?? undefined,
    },
    hasAdjClose: Array.isArray(adj),
    rows,
  };
}

// Pure: raw payload -> clean, adjusted, completed-sessions-only series.
export function normalizeSeries(raw: RawOhlcv, now: Date): PriceSeries {
  const cutoff = [lastCompletedSession(new Date(raw.fetchedAt)), lastCompletedSession(now)].sort()[0];
  const byDate = new Map<string, DailyBar>();
  for (const r of raw.rows) {
    if (r.date > cutoff) continue;
    if (r.open === null || r.high === null || r.low === null || r.close === null || r.volume === null) continue;
    if (r.close <= 0 || r.high <= 0 || r.low <= 0 || r.open <= 0) continue;
    const factor = raw.hasAdjClose && r.adjClose !== null && r.adjClose > 0 ? r.adjClose / r.close : 1;
    byDate.set(r.date, {
      date: r.date,
      open: r.open * factor,
      high: r.high * factor,
      low: r.low * factor,
      close: r.close * factor,
      rawClose: r.close,
      volume: r.volume,
    });
  }
  const bars = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  const m = raw.meta;
  return {
    symbol: raw.symbol,
    name: m.longName,
    exchange: m.exchange,
    instrumentType: m.instrumentType,
    currency: m.currency,
    bars,
    adjustment: raw.hasAdjClose ? "split+dividend" : "split-only",
    // A quote stamped after `now` can only exist in a replay – never show it.
    quote:
      m.price && m.priceTime && m.priceTime * 1000 <= now.getTime()
        ? { price: m.price, timeIso: new Date(m.priceTime * 1000).toISOString() }
        : null,
    // From the session-bounded bars (same adjusted basis as the indicators),
    // not from the payload's metadata, which reflects the fetch moment.
    fiftyTwoWeekHigh: bars.length ? Math.max(...bars.slice(-252).map((b) => b.high)) : undefined,
    fiftyTwoWeekLow: bars.length ? Math.min(...bars.slice(-252).map((b) => b.low)) : undefined,
  };
}

// A cached payload is only "fresh" if it was fetched after the session we now
// need had already closed – otherwise it can't contain that session's bar.
function coversSession(raw: RawOhlcv, expected: string): boolean {
  return lastCompletedSession(new Date(raw.fetchedAt)) >= expected;
}

export interface OhlcvResult {
  raw: RawOhlcv | null;
  source: SourceInfo;
}

export async function getDailyOhlcv(symbol: string, now: Date): Promise<OhlcvResult> {
  const key = `yahoo_ohlcv_2y_${symbol}`;
  const expected = lastCompletedSession(now);
  const fresh = readCache<RawOhlcv>(key, TTL.HOURS_24);
  if (fresh && coversSession(fresh.data, expected)) {
    return { raw: fresh.data, source: { source: "cached", ageHours: Math.round(fresh.ageHours * 10) / 10 } };
  }
  const fetchedAt = new Date();
  const result = await fetchYahooChart(symbol, { range: "2y", interval: "1d" });
  const parsed = result ? parseYahooChart(symbol, result, fetchedAt) : null;
  if (parsed) {
    writeCache(key, parsed);
    return { raw: parsed, source: { source: "live" } };
  }
  const stale = readCache<RawOhlcv>(key, STALE_FALLBACK_MS);
  if (stale) return { raw: stale.data, source: { source: "cached", ageHours: Math.round(stale.ageHours * 10) / 10 } };
  return { raw: null, source: { source: "unavailable" } };
}

// Small fixed-size worker pool – polite to an unofficial endpoint while
// keeping a ~200-symbol cold scan well inside the workflow timeout.
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
