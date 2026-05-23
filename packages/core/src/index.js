export const DB_STATE_EVENT_PREFIX = "dbstate:"

export const DB_STATE_EVENTS = Object.freeze({
  hello: "dbstate:hello",
  changesAvailable: "dbstate:changes_available",
  forceResync: "dbstate:force_resync",
  error: "dbstate:error"
})

export const DB_STATE_MESSAGES = Object.freeze({
  ...DB_STATE_EVENTS,
  rpc: "dbstate:rpc",
  rpcResult: "dbstate:rpc_result",
  rpcError: "dbstate:rpc_error",
  login: "dbstate:login",
  loginResult: "dbstate:login_result",
  loginError: "dbstate:login_error",
  auth: "dbstate:auth",
  authResult: "dbstate:auth_result",
  authError: "dbstate:auth_error",
  logout: "dbstate:logout",
  logoutResult: "dbstate:logout_result",
  socketOpen: "dbstate:socket_open",
  socketClose: "dbstate:socket_close"
})

export const SERVICE_TABLES = Object.freeze(["_user", "_group", "_permission"])

export function normalizeTables(tables) {
  return [...new Set([...tables, ...SERVICE_TABLES])]
}

export function createSessionId(userId = "user", random = defaultRandom) {
  return `${userId}_${random(10)}`
}

export function createChange(change) {
  return {
    logId: change.logId ?? defaultId(),
    createdAt: change.createdAt ?? new Date().toISOString(),
    table: change.table,
    id: change.id,
    action: change.action,
    set: change.set,
    unset: change.unset,
    obj: change.obj,
    old: change.old,
    sessionId: change.sessionId,
    userId: change.userId
  }
}

export function filterSyncChanges(changes, { from, to, sessionId }) {
  return changes
    .filter((change) => change.createdAt > from && change.createdAt <= to)
    .filter((change) => !sessionId || change.sessionId !== sessionId)
    .sort(compareChanges)
}

export function compareChanges(a, b) {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1
  }

  return String(a.logId ?? "").localeCompare(String(b.logId ?? ""))
}

export function applyChange(tables, change) {
  if (!tables[change.table]) {
    tables[change.table] = {}
  }

  const table = tables[change.table]

  if (change.action === "delete") {
    delete table[change.id]
    return
  }

  if (change.action === "insert") {
    table[change.id] = clone(change.obj ?? { id: change.id })
    return
  }

  if (change.action === "update") {
    if (!table[change.id]) {
      table[change.id] = { id: change.id }
    }

    applyPatch(table[change.id], change)
  }
}

export function applyPatch(target, change) {
  const set = change.set ?? change.objedit ?? {}
  const unset = change.unset ?? []

  for (const [path, value] of Object.entries(set)) {
    setByPath(target, path, value)
  }

  for (const path of unset) {
    unsetByPath(target, path)
  }

  return target
}

export function setByPath(target, path, value) {
  const parts = String(path).split(".").filter(Boolean)
  let cursor = target

  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]

    if (!isPlainObject(cursor[part])) {
      cursor[part] = {}
    }

    cursor = cursor[part]
  }

  cursor[parts[parts.length - 1]] = value
  return target
}

export function getByPath(target, path) {
  const parts = String(path).split(".").filter(Boolean)
  let cursor = target

  for (const part of parts) {
    if (cursor == null) return undefined
    cursor = cursor[part]
  }

  return cursor
}

export function unsetByPath(target, path) {
  const parts = String(path).split(".").filter(Boolean)
  let cursor = target

  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = cursor?.[parts[i]]
    if (cursor == null) return target
  }

  delete cursor[parts[parts.length - 1]]
  return target
}

export function isDbStateEvent(type) {
  return String(type).startsWith(DB_STATE_EVENT_PREFIX)
}

function defaultRandom(length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""

  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }

  return out
}

function defaultId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  return defaultRandom(16)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value)
}
