import assert from "node:assert/strict"
import test from "node:test"

import { createMemoryCache, createStorageCache } from "../packages/vue/src/cache.js"

test("memory cache stores, clones, deletes, and clears records", async () => {
  const cache = createMemoryCache()
  const user = { id: "u1", profile: { name: "Ivan" } }

  await cache.set("user", "u1", user)
  user.profile.name = "Changed"

  assert.deepEqual(await cache.get("user", "u1"), { id: "u1", profile: { name: "Ivan" } })

  await cache.delete("user", "u1")
  assert.equal(await cache.get("user", "u1"), undefined)

  await cache.set("user", "u2", { id: "u2" })
  await cache.clear()
  assert.equal(await cache.get("user", "u2"), undefined)
})

test("storage cache persists records as JSON", async () => {
  const storage = createMemoryStorage()
  const cache = createStorageCache({ storage, key: "test-cache" })

  await cache.set("user", "u1", { id: "u1", name: "Ivan" })

  const cache2 = createStorageCache({ storage, key: "test-cache" })
  assert.deepEqual(await cache2.get("user", "u1"), { id: "u1", name: "Ivan" })
})

function createMemoryStorage() {
  const data = new Map()

  return {
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, String(value))
  }
}
