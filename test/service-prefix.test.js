import test from "node:test"
import assert from "node:assert/strict"

import {
  createPrefixedTableName,
  createServiceTableNames,
  normalizeServicePrefix,
  normalizeTables
} from "../packages/core/src/index.js"
import { createDbStateServer } from "../packages/server-mongo/src/index.js"
import { createFileModule } from "../packages/server-files/src/index.js"
import { createFileClient } from "../packages/vue-files/src/index.js"

test("core builds prefixed service table names", () => {
  assert.equal(normalizeServicePrefix(" cfg__ "), "cfg")
  assert.equal(normalizeServicePrefix({ prefix: "tenant_" }), "tenant")
  assert.equal(normalizeServicePrefix({ servicePrefix: "svc", prefix: "tenant" }), "svc")
  assert.equal(createPrefixedTableName("cfg_", "log", "log"), "cfg_log")
  assert.deepEqual(createServiceTableNames("cfg"), ["cfg_user", "cfg_group", "cfg_permission"])
  assert.deepEqual(normalizeTables(["order"]), ["order"])
  assert.deepEqual(normalizeTables(["order"], createServiceTableNames("cfg")), [
    "order",
    "cfg_user",
    "cfg_group",
    "cfg_permission"
  ])
  assert.deepEqual(createServiceTableNames(), ["_user", "_group", "_permission"])
})

test("server prefix changes service, log and file tables", async () => {
  const mongo = createMongoRecorder()
  const files = createFileModule({ storage: createStorage() })
  const server = createDbStateServer({
    mongo,
    tables: ["order", "cfg_user", "cfg_group"],
    prefix: "cfg",
    files,
    access: {
      read: () => true,
      write: () => true
    }
  })

  await server.add({
    table: "cfg_user",
    obj: { _id: "u1", login: "admin" },
    req: { user: { _id: "admin", groups: ["admin"] } }
  })
  await server.add({
    table: "cfg_group",
    obj: { _id: "admin", name: "Admins" },
    req: { user: { _id: "admin", groups: ["admin"] } }
  })
  await server.add({
    table: "cfg_file",
    obj: {
      _id: "f1",
      ownerId: "admin",
      name: "a.txt",
      mime: "text/plain",
      size: 0,
      status: "ready",
      downloadPolicy: { mode: "registered" }
    },
    req: { __dbStateFileInternal: true, user: { _id: "admin", groups: ["admin"] } }
  })

  assert.ok(mongo.collectionNames.includes("cfg_user"))
  assert.ok(mongo.collectionNames.includes("cfg_group"))
  assert.ok(mongo.collectionNames.includes("cfg_file"))
  assert.ok(mongo.collectionNames.includes("cfg_log"))
  assert.equal(mongo.collectionNames.includes("_user"), false)
  assert.equal(mongo.collectionNames.includes("file"), false)

  await assert.rejects(
    () => server.load({ table: "_user", id: "u1", req: { user: { _id: "admin", groups: ["admin"] } } }),
    /Unknown db-state table/
  )
})

test("server prefix changes permission lookup table", async () => {
  const mongo = createMongoRecorder()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    servicePrefix: "cfg"
  })

  await assert.rejects(
    () => server.load({ table: "order", id: "o1", req: { user: { _id: "admin", groups: ["admin"] } } }),
    /Read denied/
  )

  assert.ok(mongo.collectionNames.includes("cfg_permission"))
  assert.equal(mongo.collectionNames.includes("_permission"), false)
})

test("file modules and client accept service prefix", () => {
  const files = createFileModule({ storage: createStorage(), servicePrefix: "cfg" })
  assert.equal(files.table, "cfg_file")
  assert.deepEqual(files.tables, ["cfg_file"])

  const registered = []
  const state = {
    registerTable(table) {
      registered.push(table)
    },
    socket: {
      on() {},
      onRaw() {}
    }
  }

  createFileClient(state, { prefix: "cfg" })
  assert.deepEqual(registered, ["cfg_file"])
})

function createMongoRecorder() {
  const collections = new Map()
  const collectionNames = []

  return {
    collectionNames,
    collection(name) {
      collectionNames.push(name)
      if (!collections.has(name)) collections.set(name, createCollection())
      return collections.get(name)
    }
  }
}


function createCollection() {
  const rows = []

  return {
    async findOne(filter = {}) {
      return rows.find((row) => matches(row, filter)) ?? null
    },

    find(filter = {}) {
      const result = rows.filter((row) => matches(row, filter))
      return {
        sort() {
          return this
        },
        skip() {
          return this
        },
        limit() {
          return this
        },
        async toArray() {
          return result
        }
      }
    },

    async insertOne(doc) {
      rows.push(structuredClone(doc))
      return { insertedId: doc._id }
    },

    async updateOne(filter, update, options = {}) {
      let row = rows.find((item) => matches(item, filter))
      if (!row && options.upsert) {
        row = { ...filter }
        rows.push(row)
      }
      if (row && update.$set) Object.assign(row, update.$set)
      if (row && update.$setOnInsert) Object.assign(row, update.$setOnInsert)
      return { acknowledged: true }
    },

    async deleteOne(filter) {
      const index = rows.findIndex((row) => matches(row, filter))
      if (index >= 0) rows.splice(index, 1)
      return { deletedCount: index >= 0 ? 1 : 0 }
    }
  }
}

function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && "$ne" in value) return row[key] !== value.$ne
    if (value && typeof value === "object" && "$gt" in value) return row[key] > value.$gt
    if (value && typeof value === "object" && "$lte" in value) return row[key] <= value.$lte
    return row[key] === value
  })
}

function createStorage() {
  return {
    tmpKey(uploadId) {
      return `tmp/${uploadId}.tmp`
    },
    async writeChunk() {},
    async finish() {
      return { storageKey: "files/a.file", size: 0 }
    },
    async *read() {},
    async remove() {},
    async abort() {}
  }
}
