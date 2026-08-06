import { createSessionId } from "@db-state/core"

export function getSessionId(storage, key, userId) {
  let sessionId = storage.getItem(key)

  if (!sessionId) {
    sessionId = createSessionId(userId ?? "user")
    storage.setItem(key, sessionId)
  }

  return sessionId
}

// Сохранённый вход лежит одним JSON-объектом: { userId, hash }.
//
// Хранилища умеют только строки, поэтому плоское значение теряло тип —
// числовой _id (numericIds) возвращался строкой, и authByHash уходил на
// сервер с "1" вместо 1. JSON сохраняет тип и заодно исключает состояние
// «id есть, хеша нет»: пара пишется и читается целиком.
export function readAuth(storage, key) {
  const raw = storage.getItem(key)
  if (!raw) return undefined

  try {
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== "object") return undefined
    if (saved.userId == null || !saved.hash) return undefined
    return { userId: saved.userId, hash: String(saved.hash) }
  } catch {
    // Чужое или испорченное значение — ведём себя как при отсутствии входа.
    return undefined
  }
}

export function writeAuth(storage, key, auth) {
  storage.setItem(key, JSON.stringify({ userId: auth.userId, hash: auth.hash }))
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
