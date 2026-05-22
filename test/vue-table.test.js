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
