import assert from "node:assert/strict"
import test from "node:test"

import { DB_STATE_MESSAGES } from "../packages/core/src/index.js"
import { createDbState, createMemoryCache } from "../packages/vue/src/index.js"
import { createSocketFacade } from "../packages/vue/src/socket.js"

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
  assert.equal(state.order.items.o1, undefined)
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

test("change hooks fire globally and per table", async () => {
  const state = createDbState({
    autoConnect: false,
    cache: createMemoryCache(),
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order", "user"]
  })
  const globalChanges = []
  const orderChanges = []
  const userChanges = []

  const offGlobal = state.onChange((change) => globalChanges.push(change.id))
  state.order.onChange((change) => orderChanges.push(change.id))
  state.user.onChange((change) => userChanges.push(change.id))

  await state.applyChange({
    table: "order",
    id: "o1",
    action: "insert",
    obj: { _id: "o1", status: "open" }
  })
  await state.applyChange({
    table: "user",
    id: "u1",
    action: "insert",
    obj: { _id: "u1", name: "Ivan" }
  })
  offGlobal()
  await state.applyChange({
    table: "order",
    id: "o2",
    action: "insert",
    obj: { _id: "o2", status: "new" }
  })

  assert.deepEqual(globalChanges, ["o1", "u1"])
  assert.deepEqual(orderChanges, ["o1", "o2"])
  assert.deepEqual(userChanges, ["u1"])
})

test("table action hooks receive current and deleted objects", async () => {
  const state = createDbState({
    autoConnect: false,
    cache: createMemoryCache(),
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })
  const events = []

  state.order.onAdd((obj, change) => events.push(["add", obj.status, change.id]))
  state.order.onEdit((obj, change) => events.push(["edit", obj.status, change.set.status]))
  state.order.onDelete((oldObj, change) => events.push(["delete", oldObj.status, change.id]))

  await state.applyChange({
    table: "order",
    id: "o1",
    action: "insert",
    obj: { _id: "o1", status: "open" }
  })
  await state.applyChange({
    table: "order",
    id: "o1",
    action: "update",
    set: { status: "done" }
  })
  await state.applyChange({
    table: "order",
    id: "o1",
    action: "delete"
  })

  assert.deepEqual(events, [
    ["add", "open", "o1"],
    ["edit", "done", "done"],
    ["delete", "done", "o1"]
  ])
})

test("countRef refreshes from server after creation and table changes", async () => {
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
  const counts = [3, 4]
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    return counts.shift()
  }
  state.auth.status = "authorized"

  const count = state.order.countRef({ status: "open" })
  await waitFor(() => count.value === 3)

  await state.applyChange({
    table: "order",
    id: "o4",
    action: "insert",
    obj: { _id: "o4", status: "open" }
  })
  await waitFor(() => count.value === 4)

  assert.deepEqual(calls, [
    { method: "count", payload: { table: "order", filter: { status: "open" } } },
    { method: "count", payload: { table: "order", filter: { status: "open" } } }
  ])
})

test("sync refreshes query refs once per changed table after applying the batch", async () => {
  const cache = delayedSetCache()
  const state = createDbState({
    autoConnect: false,
    cache,
    countRefreshDelay: 0,
    idsRefreshDelay: 0,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order", "product"]
  })
  const calls = []
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    if (method === "sync") {
      return {
        to: "2026-05-21T10:00:00.000Z",
        changes: [
          { table: "order", id: "o1", action: "insert", obj: { _id: "o1" } },
          { table: "order", id: "o2", action: "insert", obj: { _id: "o2" } },
          { table: "product", id: "p1", action: "insert", obj: { _id: "p1" } }
        ]
      }
    }
    if (method === "count") return Object.keys(state[payload.table].items).length
    if (method === "getIds") return Object.keys(state[payload.table].items).sort()
    return undefined
  }
  state.auth.status = "authorized"

  const orderCount = state.order.countRef({})
  const orderIds = state.order.idsRef({})
  const productCount = state.product.countRef({})
  const productIds = state.product.idsRef({})
  await waitFor(() => calls.length === 4)
  calls.length = 0

  await state.syncNow()
  await waitFor(() => (
    orderCount.value === 2 &&
    orderIds.value.length === 2 &&
    productCount.value === 1 &&
    productIds.value.length === 1
  ))

  assert.deepEqual(calls.map((call) => `${call.method}:${call.payload?.table ?? ""}`), [
    "sync:",
    "count:order",
    "getIds:order",
    "count:product",
    "getIds:product"
  ])
})

test("countRef refreshes after login but hash auth without table changes keeps cached value", async () => {
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
    if (method === "sync") return { to: "2026-05-21T10:00:00.000Z", changes: [] }
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

  assert.equal(calls[0].method, "count")
  assert.deepEqual(calls[0].payload, { table: "order", filter: {} })
  assert.equal(calls[1].method, "sync")
  assert.notEqual(calls[1].payload.from, "1970-01-01T00:00:00.000Z")
  assert.equal(calls[1].payload.sessionId, state.sync.sessionId)
  assert.equal(calls.length, 2)
})

test("client does not start safety sync interval by default", () => {
  const originalSetInterval = globalThis.setInterval
  let intervals = 0
  globalThis.setInterval = () => {
    intervals += 1
    return 1
  }

  try {
    createDbState({
      autoConnect: false,
      cache: createMemoryCache(),
      ...testStorage(),
      tables: ["order"]
    })

    assert.equal(intervals, 0)
  } finally {
    globalThis.setInterval = originalSetInterval
  }
})

test("login clears local data, moves sync cursor to now, and does not run sync", async () => {
  const cache = createMemoryCache()
  await cache.set("order", "old", { _id: "old", status: "cached" })
  const storage = testStorage()
  storage.metaStorage.setItem("db-state.time1", "2020-01-01T00:00:00.000Z")
  const state = createDbState({
    autoConnect: false,
    cache,
    ...storage,
    tables: ["order"]
  })
  state.order.items.old = { _id: "old", status: "memory", __loaded: true }
  const calls = []
  state.socket.system = async () => ({ userId: "u1", hash: "h1", ok: true })
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    throw new Error("login should not run sync RPC")
  }

  const before = Date.now()
  await state.login("ivan", "secret")
  const cursor = state.sync.time1

  assert.deepEqual(calls, [])
  assert.equal(await cache.get("order", "old"), undefined)
  assert.equal(state.order.items.old, undefined)
  assert.equal(storage.metaStorage.getItem("db-state.time1"), cursor)
  assert.ok(Date.parse(cursor) >= before)
  assert.ok(Date.parse(cursor) <= Date.now())
})

test("autoAuth refreshes uncached reactive refs after authorization", async () => {
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
    if (method === "sync") return { to: "2026-05-21T10:00:00.000Z", changes: [] }
    if (method === "count") return 4
    if (method === "getIds") return ["o1"]
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
  await waitFor(() => count.value === 4 && list.value.length === 1)

  assert.equal(state.auth.status, "authorized")
  assert.deepEqual(calls, [
    { method: "dbstate:auth", payload: { userId: "u1", hash: "h1" } },
    { method: "sync", payload: { from: "1970-01-01T00:00:00.000Z", sessionId: state.sync.sessionId } },
    { method: "count", payload: { table: "order", filter: {} } },
    { method: "getIds", payload: { table: "order", sort: { _id: 1 } } }
  ])
})

test("autoAuth refreshes cached query refs only for synced changed tables", async () => {
  const cache = createMemoryCache()
  const firstState = createDbState({
    autoConnect: false,
    cache,
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order", "product"]
  })
  firstState.socket.rpc = async (method, payload) => {
    if (method === "sync") return { to: "2026-05-21T10:00:00.000Z", changes: [] }
    if (method === "count") return payload.table === "order" ? 8 : 3
    if (method === "getIds") return payload.table === "order" ? ["o7", "o8"] : ["p1"]
    return undefined
  }
  firstState.socket.system = async () => ({ userId: "u1", hash: "h1", ok: true })

  const firstCount = firstState.order.countRef({ status: "open" })
  const firstIds = firstState.order.idsRef({ filter: { status: "open" }, sort: { _id: 1 } })
  const firstProductCount = firstState.product.countRef({})
  const firstProductIds = firstState.product.idsRef({ sort: { _id: 1 } })
  await firstState.login("ivan", "secret")
  await waitFor(() => (
    firstCount.value === 8 &&
    firstIds.value.length === 2 &&
    firstProductCount.value === 3 &&
    firstProductIds.value.length === 1
  ))

  const storage = testStorage()
  storage.authStorage.setItem("db-state.userId", "u1")
  storage.authStorage.setItem("db-state.authHash", "h1")
  const secondState = createDbState({
    autoConnect: false,
    cache,
    countRefreshDelay: 0,
    idsRefreshDelay: 0,
    safetySyncInterval: 0,
    ...storage,
    tables: ["order", "product"]
  })
  const calls = []
  secondState.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    if (method === "sync") {
      return {
        to: "2026-05-21T10:00:00.000Z",
        changes: [{
          table: "order",
          id: "o9",
          action: "insert",
          obj: { _id: "o9", status: "open" }
        }]
      }
    }
    if (payload.table === "product") throw new Error("unchanged table query refs should not refresh")
    if (method === "count") return 9
    if (method === "getIds") return ["o9"]
    return undefined
  }
  secondState.socket.system = async (type, payload) => {
    calls.push({ method: type, payload })
    return { ok: true, userId: "u1", groups: ["admin"] }
  }

  const cachedCount = secondState.order.countRef({ status: "open" })
  const cachedIds = secondState.order.idsRef({ sort: { _id: 1 }, filter: { status: "open" } })
  const cachedProductCount = secondState.product.countRef({})
  const cachedProductIds = secondState.product.idsRef({ sort: { _id: 1 } })
  await waitFor(() => (
    cachedCount.value === 8 &&
    cachedIds.value.length === 2 &&
    cachedProductCount.value === 3 &&
    cachedProductIds.value.length === 1
  ))

  assert.equal(await secondState.autoAuth(), true)

  await waitFor(() => cachedCount.value === 9 && cachedIds.value.length === 1)

  assert.equal(cachedCount.value, 9)
  assert.deepEqual(cachedIds.value, ["o9"])
  assert.equal(cachedProductCount.value, 3)
  assert.deepEqual(cachedProductIds.value, ["p1"])
  assert.deepEqual(calls, [
    { method: "dbstate:auth", payload: { userId: "u1", hash: "h1" } },
    { method: "sync", payload: { from: "1970-01-01T00:00:00.000Z", sessionId: secondState.sync.sessionId } },
    { method: "count", payload: { table: "order", filter: { status: "open" } } },
    { method: "getIds", payload: { table: "order", sort: { _id: 1 }, filter: { status: "open" } } }
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

test("socket close downgrades current authorization to restored when credentials are saved", async () => {
  const OriginalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = FakeWebSocket

  try {
    const storage = testStorage()
    storage.authStorage.setItem("db-state.userId", "u1")
    storage.authStorage.setItem("db-state.authHash", "h1")
    const state = createDbState({
      autoAuth: false,
      cache: createMemoryCache(),
      reconnectDelay: 0,
      safetySyncInterval: 0,
      ...storage,
      tables: ["order"],
      wsUrl: "ws://example.test/db-state/ws"
    })

    state.auth.status = "authorized"
    state.socket.raw.close()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(state.sync.connected, false)
    assert.equal(state.auth.status, "restored")
  } finally {
    globalThis.WebSocket = OriginalWebSocket
  }
})

test("socket rpc emits the result envelope for diagnostics", async () => {
  const OriginalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = FakeWebSocket

  try {
    const socket = createSocketFacade({
      reconnectDelay: 0,
      rpcTimeout: 50,
      wsUrl: "ws://example.test/db-state/ws"
    })
    const envelopes = []
    socket.on(DB_STATE_MESSAGES.rpcResult, (message) => envelopes.push(message))

    const rpc = socket.rpc("getIds", { table: "order" })
    await Promise.resolve()

    const request = JSON.parse(socket.raw.sent[0])
    socket.raw.emit("message", {
      data: JSON.stringify({
        type: DB_STATE_MESSAGES.rpcResult,
        id: request.id,
        result: ["o1"],
        meta: { accessFiltered: true, denied: 1 }
      })
    })

    assert.deepEqual(await rpc, ["o1"])
    assert.deepEqual(envelopes, [{
      type: DB_STATE_MESSAGES.rpcResult,
      id: request.id,
      result: ["o1"],
      meta: { accessFiltered: true, denied: 1 }
    }])
  } finally {
    globalThis.WebSocket = OriginalWebSocket
  }
})

test("load before restored authorization uses cache only and retries unloaded documents after authorization", async () => {
  const cache = createMemoryCache()
  const storage = testStorage()
  storage.authStorage.setItem("db-state.userId", "u1")
  storage.authStorage.setItem("db-state.authHash", "h1")
  const state = createDbState({
    autoConnect: false,
    cache,
    safetySyncInterval: 0,
    ...storage,
    tables: ["order"]
  })
  const calls = []
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    if (method === "sync") return { to: "2026-05-21T10:00:00.000Z", changes: [] }
    return { _id: payload.id, status: "open" }
  }
  state.socket.system = async () => ({ userId: "u1", hash: "h1", ok: true })

  const doc = state.order.load("o1")
  await waitFor(() => doc.__cacheChecked)

  assert.equal(doc.__loaded, false)
  assert.deepEqual(calls, [])

  await state.authByHash()
  await waitFor(() => doc.__loaded)

  assert.equal(doc.status, "open")
  assert.deepEqual(calls, [
    { method: "sync", payload: { from: "1970-01-01T00:00:00.000Z", sessionId: state.sync.sessionId } },
    { method: "load", payload: { table: "order", id: "o1" } }
  ])
})

test("one-off read methods wait for authorization before RPC", async () => {
  const state = createDbState({
    autoConnect: false,
    cache: createMemoryCache(),
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })
  const calls = []
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    if (method === "sync") return { to: "2026-05-21T10:00:00.000Z", changes: [] }
    if (method === "getIds") return ["o1"]
    if (method === "getUnique") return ["open"]
    return undefined
  }
  state.socket.system = async () => ({ userId: "u1", hash: "h1", ok: true })

  const idsPromise = state.order.getIds({ sort: { _id: 1 } })
  const uniquePromise = state.order.getUnique({ field: "status" })
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.deepEqual(calls, [])

  await state.login("ivan", "secret")

  assert.deepEqual(await idsPromise, ["o1"])
  assert.deepEqual(await uniquePromise, ["open"])
  assert.deepEqual(calls, [
    { method: "getIds", payload: { table: "order", sort: { _id: 1 } } },
    { method: "getUnique", payload: { table: "order", field: "status" } }
  ])
})

test("writes wait briefly for authorization and fail when it is not restored", async () => {
  const state = createDbState({
    autoConnect: false,
    cache: createMemoryCache(),
    safetySyncInterval: 0,
    writeAuthTimeout: 10,
    ...testStorage(),
    tables: ["order"]
  })
  const calls = []
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    return { ok: true }
  }

  await assert.rejects(
    () => state.order.update({ id: "o1", set: { status: "done" } }),
    /authorized/
  )
  assert.deepEqual(calls, [])
})

test("mutation methods track page loading keys", async () => {
  const state = createDbState({
    autoConnect: false,
    cache: createMemoryCache(),
    safetySyncInterval: 0,
    ...testStorage(),
    tables: ["order"]
  })
  state.auth.status = "authorized"
  const pendingRpc = []
  state.socket.rpc = async (method, payload) => {
    await new Promise((resolve) => pendingRpc.push(resolve))
    return {
      ok: true,
      id: payload.id ?? payload.obj?._id,
      change: {
        table: "order",
        id: payload.id ?? payload.obj?._id,
        action: method === "remove" ? "delete" : method === "add" ? "insert" : "update",
        obj: method === "add" ? payload.obj : undefined,
        set: method === "update" ? payload.set : undefined
      }
    }
  }

  const loading = state.getKeyRef("orders-page")
  assert.equal(loading.value, 0)
  assert.equal(loading.max, 0)
  assert.equal(loading.start, false)
  assert.equal(loading.percent, 0)
  assert.equal(loading.ready.value, true)

  const addPromise = state.order.add({ _id: "o1", status: "open" }, "orders-page")
  assert.equal(loading.value, 1)
  assert.equal(loading.max, 1)
  assert.equal(loading.start, true)
  assert.equal(loading.percent, 100)
  await waitFor(() => pendingRpc.length === 1)
  pendingRpc.shift()()
  await addPromise
  assert.equal(loading.value, 0)
  assert.equal(loading.max, 0)
  assert.equal(loading.start, true)
  assert.equal(loading.percent, 0)

  const updatePromise = state.order.update({ id: "o1", set: { status: "done" } }, "orders-page")
  assert.equal(loading.value, 1)
  assert.equal(loading.max, 1)
  await waitFor(() => pendingRpc.length === 1)
  pendingRpc.shift()()
  await updatePromise
  assert.equal(loading.value, 0)

  const addSecondPromise = state.order.add({ _id: "o2", status: "open" }, "orders-page")
  const addThirdPromise = state.order.add({ _id: "o3", status: "open" }, "orders-page")
  assert.equal(loading.value, 2)
  assert.equal(loading.max, 2)
  assert.equal(loading.percent, 100)
  await waitFor(() => pendingRpc.length === 2)
  pendingRpc.shift()()
  await waitFor(() => loading.value === 1)
  assert.equal(loading.max, 2)
  assert.equal(loading.percent, 50)
  pendingRpc.shift()()
  await Promise.all([addSecondPromise, addThirdPromise])
  assert.equal(loading.value, 0)
  assert.equal(loading.max, 0)
  assert.equal(loading.percent, 0)

  const removePromise = state.order.remove("o1", "orders-page")
  assert.equal(loading.value, 1)
  await waitFor(() => pendingRpc.length === 1)
  pendingRpc.shift()()
  await removePromise
  assert.equal(loading.value, 0)

  state.resetKey("orders-page")
  assert.equal(loading.value, 0)
  assert.equal(loading.max, 0)
  assert.equal(loading.start, false)
  assert.equal(loading.percent, 0)
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

test("idsRef refreshes from server after creation, table changes and auth", async () => {
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
  const ids = [["o1"], ["o1", "o2"], ["o1", "o2", "o3"]]
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    return ids.shift()
  }
  state.auth.status = "authorized"

  const list = state.order.idsRef({ sort: { _id: 1 } })
  await waitFor(() => list.value.length === 1)

  await state.applyChange({
    table: "order",
    id: "o2",
    action: "insert",
    obj: { _id: "o2", status: "open" }
  })
  await waitFor(() => list.value.length === 2)

  await state.applyChange({
    table: "order",
    id: "o3",
    action: "insert",
    obj: { _id: "o3", status: "open" }
  })
  await waitFor(() => list.value.length === 3)

  assert.deepEqual(calls, [
    { method: "getIds", payload: { table: "order", sort: { _id: 1 } } },
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

test("idsRef includes skip in query deduplication", async () => {
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
  state.socket.rpc = async (method, payload) => {
    calls.push({ method, payload })
    return payload.skip === 10 ? ["o11"] : ["o1"]
  }
  state.auth.status = "authorized"

  const first = state.order.idsRef({ sort: { _id: 1 }, skip: 0, limit: 10 })
  const same = state.order.idsRef({ limit: 10, sort: { _id: 1 }, skip: 0 })
  const secondPage = state.order.idsRef({ sort: { _id: 1 }, skip: 10, limit: 10 })

  assert.equal(first, same)
  assert.notEqual(first, secondPage)
  await waitFor(() => first.value.length === 1 && secondPage.value.length === 1)

  await state.applyChange({
    table: "order",
    id: "o1",
    action: "insert",
    obj: { _id: "o1", status: "open" }
  })
  await waitFor(() => calls.length === 4)

  assert.deepEqual(calls, [
    { method: "getIds", payload: { table: "order", sort: { _id: 1 }, skip: 0, limit: 10 } },
    { method: "getIds", payload: { table: "order", sort: { _id: 1 }, skip: 10, limit: 10 } },
    { method: "getIds", payload: { table: "order", sort: { _id: 1 }, skip: 0, limit: 10 } },
    { method: "getIds", payload: { table: "order", sort: { _id: 1 }, skip: 10, limit: 10 } }
  ])
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
    if (method === "sync") return { to: "2026-05-21T10:00:00.000Z", changes: [] }
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
    if (method === "sync") return { to: "2026-05-21T10:00:00.000Z", changes: [] }
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
    if (method === "sync") return { to: "2026-05-21T10:00:00.000Z", changes: [] }
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

function delayedSetCache(delay = 5) {
  const cache = createMemoryCache()
  return {
    get: cache.get,
    delete: cache.delete,
    clear: cache.clear,
    async set(...args) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      return cache.set(...args)
    }
  }
}

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0

  readyState = FakeWebSocket.OPEN
  listeners = new Map()
  sent = []

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(handler)
  }

  close() {
    this.readyState = 3
    for (const handler of this.listeners.get("close") ?? []) {
      handler({ type: "close" })
    }
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event)
    }
  }

  send(message) {
    this.sent.push(message)
  }
}

async function waitFor(check) {
  for (let i = 0; i < 20; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(check(), true)
}
