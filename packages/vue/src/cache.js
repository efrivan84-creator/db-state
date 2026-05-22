export function createMemoryCache() {
  const tables = new Map()

  return {
    async get(table, id) {
      return clone(tables.get(table)?.get(String(id)))
    },

    async set(table, id, obj) {
      if (!tables.has(table)) tables.set(table, new Map())
      tables.get(table).set(String(id), clone(obj))
    },

    async delete(table, id) {
      tables.get(table)?.delete(String(id))
    },

    async clear() {
      tables.clear()
    }
  }
}

export function createStorageCache({ storage, key = "db-state.cache" } = {}) {
  const target = storage ?? globalThis.localStorage

  return {
    async get(table, id) {
      return clone(read(target, key)[table]?.[id])
    },

    async set(table, id, obj) {
      const data = read(target, key)
      data[table] ??= {}
      data[table][id] = clone(obj)
      write(target, key, data)
    },

    async delete(table, id) {
      const data = read(target, key)
      delete data[table]?.[id]
      write(target, key, data)
    },

    async clear() {
      target?.removeItem(key)
    }
  }
}

export function createIndexedDbCache({ name = "db-state", store = "records" } = {}) {
  if (typeof indexedDB === "undefined") {
    return createMemoryCache()
  }

  const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => request.result.createObjectStore(store, { keyPath: "key" })
  })

  return {
    async get(table, id) {
      const row = await (await tx(dbPromise, store, "readonly")).get(`${table}:${id}`)
      return row?.value
    },

    async set(table, id, obj) {
      await (await tx(dbPromise, store, "readwrite")).put({
        key: `${table}:${id}`,
        table,
        id,
        value: clone(obj)
      })
    },

    async delete(table, id) {
      await (await tx(dbPromise, store, "readwrite")).delete(`${table}:${id}`)
    },

    async clear() {
      await (await tx(dbPromise, store, "readwrite")).clear()
    }
  }
}

async function tx(dbPromise, store, mode) {
  const db = await dbPromise
  const objectStore = db.transaction(store, mode).objectStore(store)

  return {
    get: (key) => req(objectStore.get(key)),
    put: (value) => req(objectStore.put(value)),
    delete: (key) => req(objectStore.delete(key)),
    clear: () => req(objectStore.clear())
  }
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

function read(storage, key) {
  const raw = storage?.getItem(key)
  return raw ? JSON.parse(raw) : {}
}

function write(storage, key, value) {
  storage?.setItem(key, JSON.stringify(value))
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}
