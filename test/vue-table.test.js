import assert from "node:assert/strict"
import test from "node:test"

import { createMemoryCache } from "../packages/vue/src/cache.js"
import { createTableApi } from "../packages/vue/src/table.js"

test("table load uses cached data without refetching for offline reads", async () => {
  let calls = 0
  const cache = createMemoryCache()
  await cache.set("order", "o1", { _id: "o1", status: "done", total: 1200 })

  const api = createTableApi({
    options: {
      cache,
      waitTimeout: 1000
    },
    state: {
      socket: {
        rpc: async () => {
          calls += 1
          throw new Error("offline")
        }
      }
    },
    table: "order",
    tables: { order: {} },
    loadingByKey: new Map(),
    keyRefs: new Map()
  })

  const doc = await api.getAsync("o1")

  assert.equal(doc.__loaded, true)
  assert.equal(doc.status, "done")
  assert.equal(doc.total, 1200)
  assert.equal(calls, 0)
})

test("load sends the id to the server unchanged and keeps a numeric _id", async () => {
  const sent = []
  const tables = { order: {} }

  const api = createTableApi({
    options: { cache: createMemoryCache(), waitTimeout: 1000 },
    state: {
      auth: { status: "authorized" },
      waitForAuthorized: async () => {},
      socket: {
        rpc: async (method, payload) => {
          sent.push(payload)
          return { _id: payload.id, status: "open" }
        }
      }
    },
    table: "order",
    tables,
    loadingByKey: new Map(),
    keyRefs: new Map()
  })

  const doc = await api.getAsync(1)

  // На сервер уходит число: строка "1" не нашла бы документ с _id: 1 в Mongo.
  assert.deepEqual(sent, [{ table: "order", id: 1 }])
  assert.equal(typeof sent[0].id, "number")
  // Ключом реактивной таблицы остаётся строка — как у всякого ключа объекта.
  assert.deepEqual(Object.keys(tables.order), ["1"])
  // А _id самого документа сохраняет исходный тип.
  assert.equal(doc._id, 1)
  assert.equal(doc.status, "open")
})

test("a numeric id stays numeric before the server answers", async () => {
  const tables = { order: {} }

  const api = createTableApi({
    options: { cache: createMemoryCache(), waitTimeout: 1000 },
    state: {
      auth: { status: "authorized" },
      waitForAuthorized: async () => {},
      socket: { rpc: async () => undefined }
    },
    table: "order",
    tables,
    loadingByKey: new Map(),
    keyRefs: new Map()
  })

  // Заглушка, которую load создаёт до ответа сервера, тоже держит число:
  // иначе повторная загрузка ушла бы строкой.
  const placeholder = api.load(7)
  assert.equal(placeholder._id, 7)
})
