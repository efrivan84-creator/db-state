import { createSessionId } from "@db-state/core"

export function getSessionId(storage, key, userId) {
  let sessionId = storage.getItem(key)

  if (!sessionId) {
    sessionId = createSessionId(userId ?? "user")
    storage.setItem(key, sessionId)
  }

  return sessionId
}

export function safeStorage(name) {
  if (typeof globalThis[name] !== "undefined") return globalThis[name]

  const data = new Map()
  return {
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, String(value))
  }
}
