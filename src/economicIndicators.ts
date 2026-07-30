import { EconomicIndicatorFn, sleep } from "./alphaVantage";
import { getEconomicIndicator } from "./dataSources";
import { LiveBudget } from "./enricher";
import { EconomicReading } from "./types";

// Latest *already released* macro readings – not a forward-looking calendar
// (no free endpoint exists for future scheduled release dates). Treasury
// yield comes from Yahoo's real ^TNX in Market Overview instead of Alpha
// Vantage, so it isn't duplicated here.
const SERIES: Array<{ key: string; fn: EconomicIndicatorFn; label: string; unit: string }> = [
  { key: "cpi", fn: "CPI", label: "CPI (מדד המחירים לצרכן, ארה\"ב)", unit: "" },
  { key: "unemployment", fn: "UNEMPLOYMENT", label: "שיעור אבטלה (ארה\"ב)", unit: "%" },
  { key: "gdp", fn: "REAL_GDP", label: 'תמ"ג ריאלי (ארה"ב)', unit: "$B" },
  { key: "fedFundsRate", fn: "FEDERAL_FUNDS_RATE", label: "ריבית הפד (Fed Funds Rate)", unit: "%" },
];

export interface EconomicIndicatorsOptions {
  apiKey: string;
  budget: LiveBudget;
  delayMs?: number;
  onProgress?: (msg: string) => void;
}

export async function buildEconomicReadings(
  opts: EconomicIndicatorsOptions
): Promise<EconomicReading[]> {
  const { apiKey, budget, delayMs = 13_000, onProgress = () => {} } = opts;
  const readings: EconomicReading[] = [];

  for (const s of SERIES) {
    const res = await getEconomicIndicator(
      s.fn,
      apiKey,
      (m) => onProgress(`   ${m}`),
      budget.allow
    );
    budget.note(res.source);
    if (res.source.source === "live") await sleep(delayMs);

    readings.push({
      key: s.key,
      label: s.label,
      value: res.value?.value ?? null,
      unit: s.unit,
      asOfDate: res.value?.date ?? null,
      source: res.source,
    });
  }

  return readings;
}
