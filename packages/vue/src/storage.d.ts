/** Minimal subset of `Web Storage API` that the client uses. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Returns or restores the session id, persisting it under `key`. */
export function getSessionId(
  storage: StorageLike,
  key: string,
  userId?: string
): string

/**
 * Returns `globalThis[name]` if available (browser), or an in-memory
 * fallback that satisfies {@link StorageLike} (Node, SSR, tests).
 */
export function safeStorage(name: "localStorage" | "sessionStorage"): StorageLike
