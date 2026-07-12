// lib/queryCache.ts
// Stale-while-revalidate cache using localStorage.
// - On first call: returns null (no cache), fetches fresh
// - On subsequent calls: returns cached instantly, fetches fresh in background, updates if changed

const CACHE_VERSION = 'v1';
const TTL_MS = 5 * 60 * 1000; // 5 minutes — after this, cache is considered stale

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  version: string;
}

function cacheKey(key: string): string {
  return `nk_cache_${key}`;
}

export function readCache<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(cacheKey(key));
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (entry.version !== CACHE_VERSION) return null;
    return entry.data;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T): void {
  if (typeof window === 'undefined') return;
  try {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      version: CACHE_VERSION,
    };
    localStorage.setItem(cacheKey(key), JSON.stringify(entry));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

export function clearCache(keyPrefix?: string): void {
  if (typeof window === 'undefined') return;
  const prefix = keyPrefix ? `nk_cache_${keyPrefix}` : 'nk_cache_';
  Object.keys(localStorage)
    .filter(k => k.startsWith(prefix))
    .forEach(k => localStorage.removeItem(k));
}

/**
 * Stale-while-revalidate fetch.
 * 
 * 1. Immediately returns cached data (or null if no cache)
 * 2. Fetches fresh data in background
 * 3. Calls onUpdate if fresh data differs from cache
 * 
 * Usage:
 *   const cached = swr('projects_list', fetchProjects, (fresh) => setItems(fresh));
 *   setItems(cached ?? []);
 */
export async function swr<T>(
  key: string,
  fetcher: () => Promise<T>,
  onUpdate: (data: T) => void,
): Promise<T | null> {
  const cached = readCache<T>(key);

  // Fetch fresh in background (or immediately if no cache)
  const fetchFresh = async () => {
    try {
      const fresh = await fetcher();
      const prev = readCache<T>(key);
      // Only update if data actually changed
      if (JSON.stringify(fresh) !== JSON.stringify(prev)) {
        writeCache(key, fresh);
        onUpdate(fresh);
      }
    } catch (err) {
      console.warn(`[cache] Background fetch failed for "${key}":`, err);
    }
  };

  if (cached !== null) {
    // Return cache immediately, fetch in background
    fetchFresh(); // fire and forget
    return cached;
  } else {
    // No cache — must wait for fresh data
    try {
      const fresh = await fetcher();
      writeCache(key, fresh);
      return fresh;
    } catch {
      return null;
    }
  }
}