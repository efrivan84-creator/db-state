import assert from "node:assert/strict"
import test from "node:test"

import { createDbState, createMemoryCache } from "../packages/vue/src/index.js"

test("sync update does not cache partial unloaded records", async () => {
  const cache = createMemoryCache()
  const state = createDbState({
    autoConnect: false,
    cache,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })

  await state.applyChange({
    table: "order",
    id: "o1",
    action: "update",
    set: { status: "done" }
  })

  assert.equal(await cache.get("order", "o1"), undefined)
})

test("sync update caches records that were already fully loaded", async () => {
  const cache = createMemoryCache()
  const state = createDbState({
    autoConnect: false,
    cache,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })

  await state.applyChange({
    table: "order",
    id: "o1",
    action: "insert",
    obj: { _id: "o1", status: "open", total: 1200 }
  })
  await state.applyChange({
    table: "order",
    id: "o1",
    action: "update",
    set: { status: "done" }
  })

  assert.deepEqual(await cache.get("order", "o1"), {
    _id: "o1",
    status: "done",
    total: 1200
  })
})

test("insert sync keeps the same reactive object when a page already loaded it", async () => {
  const state = createDbState({
    autoConnect: false,
    cache: createMemoryCache(),
    safetySyncInterval: 0,
    waitTimeout: 50,
    ...testStorage(),
    tables: ["order"]
  })
  state.socket.rpc = async () => undefined

  const visibleDoc = state.order.load("o1")

  await state.applyChange({
    table: "order",
    id: "o1",
    action: "insert",
    obj: { _id: "o1", status: "open", total: 1200 }
  })

  assert.equal(state.order.load("o1"), visibleDoc)
  assert.equal(visibleDoc.status, "open")

  await state.applyChange({
    table: "order",
    id: "o1",
    action: "update",
    set: { status: "done" }
  })

  assert.equal(visibleDoc.status, "done")
})

test("countRef refreshes from server after table changes", async () => {
  const cache = createMemoryCache()
  const state = createDbState({
    autoConnect: false,
    cache,
    countRefreshDelay: 0,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })
  const calls = []
  const counts = [4]
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    return counts.shift()
  }

  const count = state.order.countRef({ status: "open" })
  await waitFor(() => calls.length === 0)

  await state.applyChange({
    table: "order",
    id: "o4",
    action: "insert",
    obj: { _id: "o4", status: "open" }
  })
  await waitFor(() => count.value === 4)

  assert.deepEqual(calls, [
    { method: "count", payload: { table: "order", filter: { status: "open" } } }
  ])
})

test("countRef refreshes after login but not after hash auth restore", async () => {
  const cache = createMemoryCache()
  const state = createDbState({
    autoConnect: false,
    cache,
    countRefreshDelay: 0,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })
  const calls = []
  const counts = [4]
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    return counts.shift()
  }
  state.socket.system = async (type) => {
    if (type === "dbstate:login") return { userId: "u1", hash: "h1" }
    if (type === "dbstate:auth") return { ok: true }
    return { ok: true }
  }

  const count = state.order.countRef({})
  await waitFor(() => calls.length === 0)

  await state.login("ivan", "secret")
  await waitFor(() => count.value === 4)

  await state.authByHash()
  assert.equal(count.value, 4)

  assert.deepEqual(calls, [
    { method: "count", payload: { table: "order", filter: {} } }
  ])
})

test("autoAuth restores saved credentials without refreshing reactive refs", async () => {
  const cache = createMemoryCache()
  const storage = testStorage()
  storage.authStorage.setItem("db-state.userId", "u1")
  storage.authStorage.setItem("db-state.authHash", "h1")
  const state = createDbState({
    autoConnect: false,
    cache,
    countRefreshDelay: 0,
    idsRefreshDelay: 0,
    safetySyncInterval: 0,
    ...storage,
    tables: ["order"]
  })
  const calls = []
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    return undefined
  }
  state.socket.system = async (type, payload) => {
    calls.push({ method: type, payload })
    return { ok: true, userId: "u1", groups: ["admin"] }
  }

  const count = state.order.countRef({})
  const list = state.order.idsRef({ sort: { _id: 1 } })
  await waitFor(() => calls.length === 0)

  assert.equal(await state.autoAuth(), true)

  assert.equal(state.auth.status, "authorized")
  assert.equal(count.value, 0)
  assert.deepEqual(list.value, [])
  assert.deepEqual(calls, [
    { method: "dbstate:auth", payload: { userId: "u1", hash: "h1" } }
  ])
})

test("autoAuth clears stale saved credentials when hash auth is rejected", async () => {
  const cache = createMemoryCache()
  const storage = testStorage()
  storage.authStorage.setItem("db-state.userId", "u1")
  storage.authStorage.setItem("db-state.authHash", "bad")
  const errors = []
  const state = createDbState({
    autoConnect: false,
    cache,
    onError: (error) => errors.push(error.message),
    safetySyncInterval: 0,
    ...storage,
    tables: ["order"]
  })
  state.socket.system = async () => {
    throw new Error("Unauthorized")
  }

  assert.equal(await state.autoAuth(), false)

  assert.equal(state.auth.status, "anonymous")
  assert.equal(state.auth.userId, null)
  assert.equal(state.auth.hash, null)
  assert.equal(storage.authStorage.getItem("db-state.userId"), null)
  assert.equal(storage.authStorage.getItem("db-state.authHash"), null)
  assert.deepEqual(errors, ["Unauthorized"])
})

test("saved credentials start in restored status for offline cached reads", () => {
  const storage = testStorage()
  storage.authStorage.setItem("db-state.userId", "u1")
  storage.authStorage.setItem("db-state.authHash", "h1")
  const state = createDbState({
    autoConnect: false,
    cache: createMemoryCache(),
    safetySyncInterval: 0,
    ...storage,
    tables: ["order"]
  })

  assert.equal(state.auth.status, "restored")
  assert.equal(state.auth.userId, "u1")
  assert.equal(state.auth.hash, "h1")
})

test("countRef reuses an existing ref for equal filter settings", async () => {
  const cache = createMemoryCache()
  const state = createDbState({
    autoConnect: false,
    cache,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })
  const calls = []
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    return 7
  }

  const first = state.order.countRef({ status: "open", owner: { id: "u1" } })
  const second = state.order.countRef({ owner: { id: "u1" }, status: "open" })
  await waitFor(() => calls.length === 0)

  assert.equal(first, second)
  assert.deepEqual(calls, [])
})

test("idsRef refreshes from server after table changes and auth", async () => {
  const cache = createMemoryCache()
  const state = createDbState({
    autoConnect: false,
    cache,
    idsRefreshDelay: 0,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })
  const calls = []
  const ids = [["o1", "o2"], ["o1", "o2", "o3"]]
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    return ids.shift()
  }
  state.socket.system = async () => ({ userId: "u1", hash: "h1", ok: true })

  const list = state.order.idsRef({ sort: { _id: 1 } })
  await waitFor(() => calls.length === 0)

  await state.applyChange({
    table: "order",
    id: "o2",
    action: "insert",
    obj: { _id: "o2", status: "open" }
  })
  await waitFor(() => list.value.length === 2)

  await state.login("ivan", "secret")
  await waitFor(() => list.value.length === 3)

  assert.deepEqual(calls, [
    { method: "getIds", payload: { table: "order", sort: { _id: 1 } } },
    { method: "getIds", payload: { table: "order", sort: { _id: 1 } } }
  ])
})

test("idsRef reuses an existing ref for equal query settings", async () => {
  const cache = createMemoryCache()
  const state = createDbState({
    autoConnect: false,
    cache,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })
  const calls = []
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    return ["o1"]
  }

  const first = state.order.idsRef({ filter: { status: "open" }, sort: { _id: 1 }, limit: 10 })
  const second = state.order.idsRef({ limit: 10, sort: { _id: 1 }, filter: { status: "open" } })
  await waitFor(() => calls.length === 0)

  assert.equal(first, second)
  assert.deepEqual(calls, [])
})

test("countRef and idsRef load cached query values without server refresh", async () => {
  const cache = createMemoryCache()
  const firstState = createDbState({
    autoConnect: false,
    cache,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })
  firstState.socket.rpc = async (method) => {
    if (method === "count") return 8
    if (method === "getIds") return ["o7", "o8"]
    return undefined
  }
  firstState.socket.system = async () => ({ userId: "u1", hash: "h1", ok: true })

  const firstCount = firstState.order.countRef({ status: "open" })
  const firstIds = firstState.order.idsRef({ filter: { status: "open" }, sort: { _id: 1 } })
  await firstState.login("ivan", "secret")
  await waitFor(() => firstCount.value === 8 && firstIds.value.length === 2)

  const secondState = createDbState({
    autoConnect: false,
    cache,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })
  const calls = []
  secondState.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    throw new Error("server should not be called")
  }

  const cachedCount = secondState.order.countRef({ status: "open" })
  const cachedIds = secondState.order.idsRef({ sort: { _id: 1 }, filter: { status: "open" } })
  await waitFor(() => cachedCount.value === 8 && cachedIds.value.length === 2)

  assert.deepEqual(cachedIds.value, ["o7", "o8"])
  assert.deepEqual(calls, [])
})

test("listRef maps an idsRef to loaded reactive records", async () => {
  const cache = createMemoryCache()
  const state = createDbState({
    autoConnect: false,
    cache,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })
  state.socket.rpc = async (method, payload) => {
    if (method === "getIds") return ["o1", "o2"]
    if (method === "load") return { _id: payload.id, status: payload.id === "o1" ? "open" : "done" }
    return undefined
  }
  state.socket.system = async () => ({ userId: "u1", hash: "h1", ok: true })

  const rows = state.order.listRef({ sort: { _id: 1 } }, "orders")
  await state.login("ivan", "secret")
  await waitFor(() => rows.value.length === 2 && rows.value.every((row) => row.__loaded))

  assert.deepEqual(rows.value.map((row) => row.status), ["open", "done"])
})

test("clearLocalDB clears reactive query refs", async () => {
  const cache = createMemoryCache()
  const state = createDbState({
    autoConnect: false,
    cache,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })
  state.socket.rpc = async (method) => {
    if (method === "count") return 3
    if (method === "getIds") return ["o1", "o2"]
    return undefined
  }
  state.socket.system = async () => ({ userId: "u1", hash: "h1", ok: true })

  const count = state.order.countRef({})
  const ids = state.order.idsRef({})
  await state.login("ivan", "secret")
  await waitFor(() => count.value === 3 && ids.value.length === 2)

  await state.clearLocalDB()

  assert.equal(count.value, 0)
  assert.deepEqual(ids.value, [])
})

function testStorage() {
  return {
    authStorage: memoryStorage(),
    metaStorage: memoryStorage(),
    sessionStorage: memoryStorage()
  }
}

function memoryStorage() {
  const data = new Map()
  return {
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, String(value))
  }
}

async function waitFor(check) {
  for (let i = 0; i < 20; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(check(), true)
}
