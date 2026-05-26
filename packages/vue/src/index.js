import { reactive } from "vue"

import { DB_STATE_MESSAGES, applyPatch, normalizeTables } from "@db-state/core"
import { createIndexedDbCache, createMemoryCache, createStorageCache } from "./cache.js"
import { createChangeHooks, notifyChangeHooks, subscribe } from "./hooks.js"
import { getKeyRef } from "./keys.js"
import { createSocketFacade } from "./socket.js"
import { getSessionId, safeStorage } from "./storage.js"
import {
  clearAllCountRefs,
  clearAllIdsRefs,
  createTableApi,
  refreshAllCountRefs,
  refreshAllIdsRefs,
  scheduleCountRefresh,
  scheduleIdsRefresh
} from "./table.js"

export { createIndexedDbCache, createMemoryCache, createStorageCache }

export function createDbState(input) {
  const options = normalizeOptions(input)
  const tables = Object.fromEntries(options.tables.map((table) => [table, {}]))
  const keyRefs = new Map()
  const loadingByKey = new Map()
  const countRefs = new Map()
  const idsRefs = new Map()
  const changeHooks = createChangeHooks(options.tables)
  const sessionId = getSessionId(options.sessionStorage, options.sessionKey, options.userId)
  const savedUserId = options.authStorage.getItem(options.userIdKey)
  const savedAuthHash = options.authStorage.getItem(options.authHashKey)
  let syncPromise
  let autoAuthPromise

  const state = reactive({
    sync: {
      connected: false,
      sessionId,
      status: "idle",
      time1: options.metaStorage.getItem(options.syncKey) ?? "1970-01-01T00:00:00.000Z"
    },

    socket: createSocketFacade(options),

    auth: {
      userId: savedUserId,
      hash: savedAuthHash,
      status: savedUserId && savedAuthHash ? "restored" : "anonymous"
    },

    getKeyRef(key) {
      return getKeyRef(keyRefs, key)
    },

    resetKey(key) {
      loadingByKey.delete(key)
      const loading = getKeyRef(keyRefs, key)
      loading.value = 0
      loading.max = 0
      loading.start = false
    },

    onChange(callback) {
      return subscribe(changeHooks.global, callback)
    },

    registerTable(table) {
      if (state[table]) return state[table]
      options.tables.push(table)
      tables[table] = {}
      changeHooks.tables.set(table, new Set())
      state[table] = createTableApi({ options, state, table, tables, loadingByKey, keyRefs, countRefs, idsRefs, changeHooks })
      return state[table]
    },

    async syncNow() {
      if (state.auth.status !== "authorized") return
      if (syncPromise) return syncPromise
      state.sync.status = "syncing"

      syncPromise = (async () => {
        const response = await state.socket.rpc("sync", {
          from: state.sync.time1,
          sessionId: state.sync.sessionId
        })

        for (const change of response.changes ?? []) {
          await state.applyChange(change)
        }

        state.sync.time1 = response.to
        options.metaStorage.setItem(options.syncKey, response.to)
        state.sync.status = "idle"
        syncPromise = undefined
      })()

      try {
        return await syncPromise
      } catch (error) {
        state.sync.status = "error"
        syncPromise = undefined
        throw error
      }
    },

    async applyChange(change) {
      const wasLoaded = Boolean(tables[change.table]?.[change.id]?.__loaded)
      const oldObj = change.action === "delete" ? (change.old ?? tables[change.table]?.[change.id]) : undefined
      applyReactiveChange(tables, change)
      const obj = tables[change.table]?.[change.id]
      if (change.action === "insert" && tables[change.table]?.[change.id]) {
        tables[change.table][change.id].__loaded = true
      }
      await writeCache(options.cache, change, tables[change.table]?.[change.id], wasLoaded)
      scheduleCountRefresh(countRefs, change.table, options)
      scheduleIdsRefresh(idsRefs, change.table, options)
      notifyChangeHooks(changeHooks, options, change, obj, oldObj)
    },

    async clearLocalDB() {
      options.metaStorage.removeItem(options.syncKey)
      options.sessionStorage.removeItem(options.sessionKey)
      await options.cache.clear()
      state.sync.time1 = "1970-01-01T00:00:00.000Z"

      for (const table of options.tables) {
        for (const id of Object.keys(tables[table])) {
          delete tables[table][id]
        }
      }

      clearAllCountRefs(countRefs)
      clearAllIdsRefs(idsRefs)
    },

    async login(login, password) {
      const result = await state.socket.system(DB_STATE_MESSAGES.login, { login, password })
      saveAuth(options, result)
      state.auth.userId = result.userId
      state.auth.hash = result.hash
      state.auth.status = "authorized"
      await syncAfterAuth(state, options)
      await refreshAllCountRefs(countRefs)
      await refreshAllIdsRefs(idsRefs)
      await retryUnloadedTables(state, options)
      return result
    },

    async authByHash() {
      if (!state.auth.userId || !state.auth.hash) return false
      state.auth.status = "authorizing"

      try {
        const result = await state.socket.system(DB_STATE_MESSAGES.auth, {
          userId: state.auth.userId,
          hash: state.auth.hash
        })
        state.auth.status = "authorized"
        await syncAfterAuth(state, options)
        await retryUnloadedTables(state, options)
        return result.ok
      } catch (error) {
        clearAuth(options)
        state.auth.userId = null
        state.auth.hash = null
        state.auth.status = "anonymous"
        options.onError(error)
        return false
      }
    },

    async autoAuth() {
      if (!options.autoAuth) return false
      if (state.auth.status === "authorized") return true
      if (!state.auth.userId || !state.auth.hash) return false
      if (autoAuthPromise) return autoAuthPromise

      autoAuthPromise = state.authByHash().finally(() => {
        autoAuthPromise = undefined
      })
      return autoAuthPromise
    },

    async logout() {
      await state.socket.system(DB_STATE_MESSAGES.logout).catch(options.onError)
      clearAuth(options)
      state.auth.userId = null
      state.auth.hash = null
      state.auth.status = "anonymous"
    },

    waitForAuthorized(timeout) {
      return waitForAuthorized(state, timeout)
    }
  })

  for (const table of options.tables) {
    state[table] = createTableApi({ options, state, table, tables, loadingByKey, keyRefs, countRefs, idsRefs, changeHooks })
  }

  state.socket.on(DB_STATE_MESSAGES.socketOpen, async () => {
    state.sync.connected = true
    await syncWhenReady(state, options)
  })
  state.socket.on(DB_STATE_MESSAGES.socketClose, () => {
    state.sync.connected = false
    if (state.auth.status === "authorized" || state.auth.status === "authorizing") {
      state.auth.status = state.auth.userId && state.auth.hash ? "restored" : "anonymous"
    }
  })
  state.socket.on(DB_STATE_MESSAGES.hello, async () => {
    state.sync.connected = true
    await syncWhenReady(state, options)
  })
  state.socket.on(DB_STATE_MESSAGES.changesAvailable, async () => {
    await state.syncNow()
  })
  state.socket.on(DB_STATE_MESSAGES.forceResync, async () => {
    state.sync.time1 = "1970-01-01T00:00:00.000Z"
    await state.syncNow()
  })

  if (options.autoConnect) {
    state.socket.connect()
  }

  if (options.safetySyncInterval > 0) {
    setInterval(() => {
      if (state.sync.connected) state.syncNow().catch(options.onError)
    }, options.safetySyncInterval)
  }

  return state
}

function normalizeOptions(input) {
  const options = Array.isArray(input) ? { tables: input } : input
  const origin = typeof location === "undefined" ? "http://localhost" : location.origin
  const wsOrigin = origin.replace(/^http/, "ws")

  const defaults = {
    autoConnect: true,
    autoAuth: true,
    countRefreshDelay: 50,
    idsRefreshDelay: 50,
    metaStorage: safeStorage("localStorage"),
    onError: (error) => console.error(error),
    reconnectDelay: 1000,
    rpcTimeout: 15000,
    safetySyncInterval: 0,
    sessionKey: "db-state.sessionId",
    sessionStorage: safeStorage("sessionStorage"),
    authStorage: safeStorage("localStorage"),
    authHashKey: "db-state.authHash",
    userIdKey: "db-state.userId",
    syncKey: "db-state.time1",
    syncOnAuth: true,
    waitTimeout: 15000,
    writeAuthTimeout: 3000,
    wsUrl: `${wsOrigin}/db-state/ws`,
    ...options
  }

  return {
    ...defaults,
    tables: normalizeTables(defaults.tables),
    cache: defaults.cache ?? createIndexedDbCache()
  }
}

async function syncWhenReady(state, options) {
  try {
    const wasAuthorized = state.auth.status === "authorized"
    if (options.autoAuth) await state.autoAuth()
    if ((!options.autoAuth || wasAuthorized) && state.auth.status === "authorized") {
      await syncAfterAuth(state, options)
    }
  } catch (error) {
    options.onError(error)
  }
}

async function syncAfterAuth(state, options) {
  if (options.syncOnAuth) await state.syncNow()
}

function saveAuth(options, result) {
  options.authStorage.setItem(options.userIdKey, result.userId)
  options.authStorage.setItem(options.authHashKey, result.hash)
}

function clearAuth(options) {
  options.authStorage.removeItem(options.userIdKey)
  options.authStorage.removeItem(options.authHashKey)
}

function applyReactiveChange(tables, change) {
  if (!tables[change.table]) {
    tables[change.table] = {}
  }

  const table = tables[change.table]

  if (change.action === "delete") {
    delete table[change.id]
    return
  }

  if (change.action === "insert") {
    const obj = change.obj ?? { id: change.id, _id: change.id }

    if (table[change.id]) {
      replaceRecord(table[change.id], obj)
    } else {
      table[change.id] = obj
    }

    return
  }

  if (change.action === "update") {
    if (!table[change.id]) return

    applyPatch(table[change.id], change)
  }
}

async function retryUnloadedTables(state, options) {
  const retries = []

  for (const table of options.tables) {
    retries.push(state[table].__retryUnloaded())
  }

  await Promise.all(retries)
}

function waitForAuthorized(state, timeout) {
  if (state.auth.status === "authorized") return Promise.resolve(true)

  const startedAt = Date.now()

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (state.auth.status === "authorized") {
        clearInterval(timer)
        resolve(true)
      } else if (timeout != null && Date.now() - startedAt >= timeout) {
        clearInterval(timer)
        resolve(false)
      }
    }, 20)
  })
}

function replaceRecord(target, source) {
  for (const key of Object.keys(target)) {
    if (!key.startsWith("__") && !(key in source)) {
      delete target[key]
    }
  }

  Object.assign(target, source)
}

async function writeCache(cache, change, obj, wasLoaded) {
  if (change.action === "delete") {
    await cache.delete(change.table, change.id)
  } else if (change.action === "insert" && obj) {
    await cache.set(change.table, change.id, cleanRecord(obj))
  } else if (change.action === "update" && wasLoaded && obj) {
    await cache.set(change.table, change.id, cleanRecord(obj))
  }
}

function cleanRecord(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !key.startsWith("__")))
}
