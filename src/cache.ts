import fs from "fs";
import path from "path";

const CACHE_DIR = path.resolve(process.cwd(), "cache");

export const TTL = {
  HOURS_12: 12 * 60 * 60 * 1000,
  HOURS_24: 24 * 60 * 60 * 1000,
};

interface CacheEnvelope<T> {
  savedAt: string;
  data: T;
}

export interface CacheHit<T> {
  data: T;
  savedAt: Date;
  ageMs: number;
  ageHours: number;
}

function ensureDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function filePath(key: string): string {
  return path.join(CACHE_DIR, `${safeKey(key)}.json`);
}

// Read cache entry. If maxAgeMs given, returns null when stale.
// Pass maxAgeMs=Infinity to read any cached value regardless of age (fallback mode).
export function readCache<T>(
  key: string,
  maxAgeMs: number
): CacheHit<T> | null {
  try {
    const fp = filePath(key);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, "utf8");
    const env = JSON.parse(raw) as CacheEnvelope<T>;
    const savedAt = new Date(env.savedAt);
    const ageMs = Date.now() - savedAt.getTime();
    if (ageMs > maxAgeMs) return null;
    return {
      data: env.data,
      savedAt,
      ageMs,
      ageHours: ageMs / (60 * 60 * 1000),
    };
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T): void {
  try {
    ensureDir();
    const env: CacheEnvelope<T> = {
      savedAt: new Date().toISOString(),
      data,
    };
    fs.writeFileSync(filePath(key), JSON.stringify(env, null, 2), "utf8");
  } catch {
    // Cache failures are non-fatal
  }
}
