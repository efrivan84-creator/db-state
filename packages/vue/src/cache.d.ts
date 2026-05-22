import type { StorageLike } from "./storage"

/**
 * Persistent or in-memory record cache used by the client to avoid
 * round-trips for already-loaded documents.
 *
 * Implementations:
 * - {@link createIndexedDbCache} — production default in the browser.
 * - {@link createStorageCache}   — simple localStorage-backed fallback.
 * - {@link createMemoryCache}    — non-persistent, used in SSR and tests.
 *
 * Custom backends can be passed via `createDbState({ cache })`.
 */
export interface DbStateCache {
  get<T = unknown>(table: string, id: string): Promise<T | undefined>
  set<T = unknown>(table: string, id: string, value: T): Promise<void>
  delete(table: string, id: string): Promise<void>
  clear(): Promise<void>
}

/** Returns an in-memory cache. Used as a fallback when IndexedDB is unavailable. */
export function createMemoryCache(): DbStateCache

/** Returns a cache backed by a {@link StorageLike} (default: `localStorage`). */
export function createStorageCache(options?: {
  storage?: StorageLike
  /** Key under which the JSON-serialised cache is stored. Default `"db-state.cache"`. */
  key?: string
}): DbStateCache

/**
 * Returns a cache backed by IndexedDB. Falls back to {@link createMemoryCache}
 * when `indexedDB` is not defined (e.g. in Node).
 */
export function createIndexedDbCache(options?: {
  /** IndexedDB database name. Default `"db-state"`. */
  name?: string
  /** Object store name. Default `"records"`. */
  store?: string
}): DbStateCache
