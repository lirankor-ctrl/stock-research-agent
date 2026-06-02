import axios from "axios";
import { readCache, TTL, writeCache } from "./cache";
import { FearGreed } from "./types";

// CNN's public Fear & Greed data endpoint (dataviz). It blocks requests
// without a browser-like User-Agent, so we send one.
const CNN_URL =
  "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
const CACHE_KEY = "fear_greed";
const STALE_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7d – stale data beats none

const CLASSIFICATION: Record<string, { en: string; he: string }> = {
  "extreme fear": { en: "Extreme Fear", he: "שוק במצב פחד קיצוני" },
  fear: { en: "Fear", he: "שוק במצב פחד" },
  neutral: { en: "Neutral", he: "שוק במצב ניטרלי" },
  greed: { en: "Greed", he: "שוק במצב חמדנות" },
  "extreme greed": { en: "Extreme Greed", he: "שוק במצב חמדנות קיצונית" },
};

// Prefer CNN's own rating; fall back to deriving it from the score.
function classify(score: number, rating?: string): { en: string; he: string } {
  const key = (rating ?? "").trim().toLowerCase();
  if (CLASSIFICATION[key]) return CLASSIFICATION[key];
  if (score < 25) return CLASSIFICATION["extreme fear"];
  if (score < 45) return CLASSIFICATION["fear"];
  if (score <= 55) return CLASSIFICATION["neutral"];
  if (score < 75) return CLASSIFICATION["greed"];
  return CLASSIFICATION["extreme greed"];
}

async function fetchLive(): Promise<FearGreed | null> {
  const { data } = await axios.get(CNN_URL, {
    timeout: 15000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  const fg = data?.fear_and_greed;
  if (!fg || typeof fg.score !== "number") return null;

  const score = Math.round(fg.score);
  const cls = classify(score, fg.rating);
  return {
    score,
    rating: String(fg.rating ?? "").toLowerCase(),
    classification: cls.en,
    hebrew: cls.he,
  };
}

// Cache-first to avoid excessive requests: fresh cache (12h) → live → stale
// cache (7d) → null. Returns null only when CNN is unreachable and no cache
// exists, in which case the report shows "Fear & Greed Index unavailable".
export async function getFearGreed(
  onNote: (msg: string) => void = () => {}
): Promise<FearGreed | null> {
  const fresh = readCache<FearGreed>(CACHE_KEY, TTL.HOURS_12);
  if (fresh) return fresh.data;

  try {
    const live = await fetchLive();
    if (live) {
      writeCache(CACHE_KEY, live);
      return live;
    }
  } catch (err: any) {
    onNote(`⚠️  Fear & Greed fetch failed: ${err.message ?? err}`);
  }

  const stale = readCache<FearGreed>(CACHE_KEY, STALE_FALLBACK_MS);
  return stale ? stale.data : null;
}
