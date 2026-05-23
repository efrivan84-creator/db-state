import { computed, reactive, ref } from "vue"

import { trackLoadedKey, trackPendingKey } from "./keys.js"

export function createTableApi(ctx) {
  const { options, state, table, tables, loadingByKey, keyRefs, countRefs, idsRefs } = ctx
  const loading = new Set()
  const errors = reactive({})

  function load(id, key) {
    if (id == null) return undefined
    const normalizedId = String(id)

    if (!tables[table][normalizedId]) {
      tables[table][normalizedId] = reactive({
        id: normalizedId,
        _id: normalizedId,
        __cacheChecked: false,
        __loaded: false
      })
    }

    if (!loading.has(normalizedId) && !tables[table][normalizedId].__loaded) {
      queueLoad({ options, state, table, id: normalizedId, target: tables[table][normalizedId], loading, errors, key, loadingByKey, keyRefs })
    } else if (key) {
      trackLoadedKey({ key, loadingByKey, keyRefs, token: `${table}:${normalizedId}` })
    }

    return tables[table][normalizedId]
  }

  const api = reactive({
    items: tables[table],
    errors,
    load,

    async getAsync(id, key) {
      const item = this.load(id, key)
      if (item?.__loaded) return item

      await waitUntil(() => item.__loaded || item.__cacheChecked || errors[id], options.waitTimeout)
      if (item?.__loaded || errors[id]) return errors[id] ? undefined : item

      await state.waitForAuthorized()
      this.load(id, key)
      await waitUntil(() => item.__loaded || errors[id], options.waitTimeout)
      return errors[id] ? undefined : item
    },

    async getIds(query = {}, key) {
      const token = `${table}:getIds:${JSON.stringify(query)}`
      trackPendingKey({ key, loadingByKey, keyRefs, token })

      try {
        await state.waitForAuthorized()
        return await state.socket.rpc("getIds", { table, ...query })
      } finally {
        trackLoadedKey({ key, loadingByKey, keyRefs, token })
      }
    },

    async getUnique(query = {}, key) {
      const token = `${table}:getUnique:${JSON.stringify(query)}`
      trackPendingKey({ key, loadingByKey, keyRefs, token })

      try {
        await state.waitForAuthorized()
        return await state.socket.rpc("getUnique", { table, ...query })
      } finally {
        trackLoadedKey({ key, loadingByKey, keyRefs, token })
      }
    },

    countRef(filter = {}) {
      const filterKey = stableStringify(filter)
      if (!countRefs.has(table)) countRefs.set(table, new Map())
      if (countRefs.get(table).has(filterKey)) return countRefs.get(table).get(filterKey).value

      const value = ref(0)
      const entry = {
        cacheId: queryCacheId("count", table, filterKey),
        value,
        filter,
        loaded: false,
        timer: undefined,
        refresh: async () => {
          if (state.auth.status !== "authorized") {
            entry.loaded = false
            return
          }

          try {
            const count = await state.socket.rpc("count", { table, filter })
            value.value = count
            entry.loaded = true
            await options.cache.set(QUERY_CACHE_TABLE, entry.cacheId, count)
          } catch (error) {
            entry.loaded = false
            options.onError(error)
          }
        }
      }

      countRefs.get(table).set(filterKey, entry)
      readCachedQuery(options.cache, entry)

      return value
    },

    idsRef(query = {}) {
      const queryKey = stableStringify(query)
      if (!idsRefs.has(table)) idsRefs.set(table, new Map())
      if (idsRefs.get(table).has(queryKey)) return idsRefs.get(table).get(queryKey).value

      const value = ref([])
      const entry = {
        cacheId: queryCacheId("ids", table, queryKey),
        value,
        query,
        loaded: false,
        timer: undefined,
        refresh: async () => {
          if (state.auth.status !== "authorized") {
            entry.loaded = false
            return
          }

          try {
            const ids = await state.socket.rpc("getIds", { table, ...query })
            value.value = ids
            entry.loaded = true
            await options.cache.set(QUERY_CACHE_TABLE, entry.cacheId, ids)
          } catch (error) {
            entry.loaded = false
            options.onError(error)
          }
        }
      }

      idsRefs.get(table).set(queryKey, entry)
      readCachedQuery(options.cache, entry)

      return value
    },

    listRef(query = {}, key) {
      const ids = api.idsRef(query)
      return computed(() => ids.value.map((id) => load(id, key)))
    },

    async update({ id, objedit, set = objedit, unset }) {
      await requireAuthorizedForWrite(state, options)
      const response = await state.socket.rpc("update", {
        table,
        id,
        set,
        unset,
        sessionId: state.sync.sessionId
      })

      await state.applyChange(response.change)
      return response
    },

    async add(obj) {
      await requireAuthorizedForWrite(state, options)
      const response = await state.socket.rpc("add", {
        table,
        obj,
        sessionId: state.sync.sessionId
      })

      await state.applyChange(response.change)
      return response
    },

    async remove(id) {
      await requireAuthorizedForWrite(state, options)
      const response = await state.socket.rpc("remove", {
        table,
        id,
        sessionId: state.sync.sessionId
      })

      await state.applyChange(response.change)
      return response
    },

    getError(id) {
      return errors[id]
    },

    isLoading(id) {
      return loading.has(String(id))
    },

    async __retryUnloaded() {
      const refreshes = []

      for (const [id, item] of Object.entries(tables[table])) {
        if (!item.__loaded && !loading.has(id)) {
          refreshes.push(queueLoad({ options, state, table, id, target: item, loading, errors, loadingByKey, keyRefs }))
        }
      }

      for (const entry of countRefs.get(table)?.values() ?? []) {
        if (!entry.loaded) refreshes.push(entry.refresh())
      }

      for (const entry of idsRefs.get(table)?.values() ?? []) {
        if (!entry.loaded) refreshes.push(entry.refresh())
      }

      await Promise.all(refreshes)
    }
  })

  return api
}

export function scheduleCountRefresh(countRefs, table, options) {
  for (const entry of countRefs.get(table)?.values() ?? []) {
    clearTimeout(entry.timer)
    entry.loaded = false
    entry.timer = setTimeout(entry.refresh, options.countRefreshDelay)
  }
}

export async function refreshAllCountRefs(countRefs) {
  const refreshes = []
  for (const entries of countRefs.values()) {
    for (const entry of entries.values()) {
      clearTimeout(entry.timer)
      refreshes.push(entry.refresh())
    }
  }
  await Promise.all(refreshes)
}

export function clearAllCountRefs(countRefs) {
  for (const entries of countRefs.values()) {
    for (const entry of entries.values()) {
      clearTimeout(entry.timer)
      entry.value.value = 0
      entry.loaded = false
    }
  }
}

export function scheduleIdsRefresh(idsRefs, table, options) {
  for (const entry of idsRefs.get(table)?.values() ?? []) {
    clearTimeout(entry.timer)
    entry.loaded = false
    entry.timer = setTimeout(entry.refresh, options.idsRefreshDelay)
  }
}

export async function refreshAllIdsRefs(idsRefs) {
  const refreshes = []
  for (const entries of idsRefs.values()) {
    for (const entry of entries.values()) {
      clearTimeout(entry.timer)
      refreshes.push(entry.refresh())
    }
  }
  await Promise.all(refreshes)
}

export function clearAllIdsRefs(idsRefs) {
  for (const entries of idsRefs.values()) {
    for (const entry of entries.values()) {
      clearTimeout(entry.timer)
      entry.value.value = []
      entry.loaded = false
    }
  }
}

async function queueLoad(input) {
  const { options, state, table, id, target, loading, errors, key, loadingByKey, keyRefs } = input
  const token = `${table}:${id}`
  loading.add(id)
  delete errors[id]
  trackPendingKey({ key, loadingByKey, keyRefs, token })

  try {
    const cached = await options.cache.get(table, id)
    target.__cacheChecked = true
    if (cached) {
      Object.assign(target, cached, { __cacheChecked: true, __loaded: true })
      return
    }

    if (state.auth.status !== "authorized") return

    const obj = await state.socket.rpc("load", { table, id })
    if (obj) {
      Object.assign(target, obj, { __cacheChecked: true, __loaded: true })
      await options.cache.set(table, id, obj)
    }
  } catch (error) {
    errors[id] = error
  } finally {
    loading.delete(id)
    trackLoadedKey({ key, loadingByKey, keyRefs, token })
  }
}

function waitUntil(check, timeout) {
  const start = Date.now()

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (check() || Date.now() - start > timeout) {
        clearInterval(timer)
        resolve()
      }
    }, 20)
  })
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

const QUERY_CACHE_TABLE = "__dbstate_query"

function queryCacheId(kind, table, key) {
  return `${kind}:${table}:${key}`
}

async function readCachedQuery(cache, entry) {
  try {
    const cached = await cache.get(QUERY_CACHE_TABLE, entry.cacheId)
    if (cached !== undefined) {
      entry.value.value = cached
      entry.loaded = true
    }
  } catch {
    // Cache reads are an offline optimization; server refresh remains authoritative.
  }
}

async function requireAuthorizedForWrite(state, options) {
  const authorized = await state.waitForAuthorized(options.writeAuthTimeout)
  if (!authorized) throw new Error("db-state write requires authorized socket")
}
