import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { setByPath, unsetByPath } from "@db-state/core"
import { createFileModule } from "../packages/server-files/src/index.js"
import { createDbStateServer } from "../packages/server-mongo/src/index.js"

test("file module uploads through the db-state socket and exposes safe metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "db-state-files-"))
  try {
    const mongo = createMemoryMongo()
    const files = createFileModule({
      storage: root,
      chunkSize: 3,
      maxSize: 20,
      defaultPolicy: { mode: "registered" }
    })
    const server = createDbStateServer({
      mongo,
      tables: ["message"],
      files,
      now: clock(["2026-05-21T10:00:01.000Z", "2026-05-21T10:00:02.000Z"]),
      createLogId: idSeq()
    })
    const client = new FakeSocketClient()
    server.socket.addClient(client, { user: { _id: "u1", groups: ["users"] }, userId: "u1", sessionId: "s1" })

    await client.receiveJson({
      type: "dbfile:upload_start",
      id: "up1",
      name: "a.txt",
      mime: "text/plain",
      size: 5,
      policy: { mode: "registered" }
    })
    assert.deepEqual(lastJson(client, "dbfile:upload_next"), {
      type: "dbfile:upload_next",
      id: "up1",
      offset: 0,
      chunkSize: 3
    })

    await client.receiveBinary(Buffer.from("hel"))
    assert.deepEqual(lastJson(client, "dbfile:upload_next"), {
      type: "dbfile:upload_next",
      id: "up1",
      offset: 3,
      chunkSize: 2
    })

    await client.receiveBinary(Buffer.from("lo"))
    const done = lastJson(client, "dbfile:upload_done")
    assert.equal(done.type, "dbfile:upload_done")
    assert.equal(done.id, "up1")
    assert.equal(done.file.name, "a.txt")
    assert.equal(done.file.mime, "text/plain")
    assert.equal(done.file.size, 5)
    assert.equal(done.file.status, "ready")
    assert.equal(typeof done.token, "string")
    assert.equal("storageKey" in done.file, false)

    const stored = await mongo.collection("file").findOne({ _id: done.fileId })
    assert.equal(stored.ownerId, "u1")
    assert.equal(stored.status, "ready")
    assert.equal(stored.token, done.token)
    assert.match(stored.storageKey, /^files\/[a-z0-9]{2}\/[a-z0-9]{2}\/.+\.file$/)
    assert.equal(await readFile(path.join(root, stored.storageKey), "utf8"), "hello")

    const visible = await server.load({ table: "file", id: done.fileId, req: { client } })
    assert.equal(visible.token, done.token)
    assert.equal(visible.storageKey, undefined)

    await assert.rejects(
      () => server.add({ table: "file", obj: { _id: "manual" }, req: { client } }),
      /Write denied/
    )
    await assert.rejects(
      () => server.update({ table: "file", id: done.fileId, set: { name: "manual.txt" }, req: { client } }),
      /Write denied/
    )
    await assert.rejects(
      () => server.remove({ table: "file", id: done.fileId, req: { client } }),
      /Write denied/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("file module downloads by token through binary chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "db-state-files-"))
  try {
    const mongo = createMemoryMongo()
    const files = createFileModule({
      storage: root,
      chunkSize: 3,
      defaultPolicy: { mode: "public" }
    })
    const server = createDbStateServer({
      mongo,
      tables: [],
      files,
      now: clock([
        "2026-05-21T10:00:01.000Z",
        "2026-05-21T10:00:02.000Z",
        "2026-05-21T10:00:03.000Z"
      ]),
      createLogId: idSeq()
    })
    const owner = new FakeSocketClient()
    server.socket.addClient(owner, { user: { _id: "u1", groups: [] }, userId: "u1" })

    await owner.receiveJson({
      type: "dbfile:upload_start",
      id: "up1",
      name: "public.txt",
      mime: "text/plain",
      size: 5,
      policy: { mode: "public" }
    })
    await owner.receiveBinary(Buffer.from("hel"))
    await owner.receiveBinary(Buffer.from("lo"))
    const token = lastJson(owner, "dbfile:upload_done").token

    const anonymous = new FakeSocketClient()
    server.socket.addClient(anonymous)
    await anonymous.receiveJson({
      type: "dbfile:download_start",
      id: "dl1",
      token,
      chunkSize: 2
    })
    assert.equal(Buffer.from(lastBinary(anonymous)).toString("utf8"), "he")

    await anonymous.receiveJson({ type: "dbfile:download_next", id: "dl1", offset: 2 })
    assert.equal(Buffer.from(lastBinary(anonymous)).toString("utf8"), "ll")

    await anonymous.receiveJson({ type: "dbfile:download_next", id: "dl1", offset: 4 })
    assert.equal(Buffer.from(lastBinary(anonymous)).toString("utf8"), "o")
    assert.equal(lastJson(anonymous, "dbfile:download_done").name, "public.txt")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("file module enforces registered, groups and verified download policies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "db-state-files-"))
  try {
    const mongo = createMemoryMongo()
    const files = createFileModule({ storage: root })
    const server = createDbStateServer({
      mongo,
      tables: [],
      files,
      now: clock(["2026-05-21T10:00:01.000Z"]),
      createLogId: idSeq()
    })
    await seedStoredFile(root, mongo, "registered", { mode: "registered" })
    await seedStoredFile(root, mongo, "groups", { mode: "groups", groups: ["staff"] })
    await seedStoredFile(root, mongo, "verified", { mode: "verified", verified: "email" })

    const anonymous = new FakeSocketClient()
    server.socket.addClient(anonymous)
    await anonymous.receiveJson({ type: "dbfile:download_start", id: "r0", token: "registered", chunkSize: 2 })
    assert.equal(lastJson(anonymous, "dbfile:error").error, "Authentication required")

    const wrongGroup = new FakeSocketClient()
    server.socket.addClient(wrongGroup, { user: { _id: "u2", groups: ["guest"] }, userId: "u2" })
    await wrongGroup.receiveJson({ type: "dbfile:download_start", id: "g0", token: "groups", chunkSize: 2 })
    assert.equal(lastJson(wrongGroup, "dbfile:error").error, "File access denied")

    const staff = new FakeSocketClient()
    server.socket.addClient(staff, { user: { _id: "u3", groups: ["staff"] }, userId: "u3" })
    await staff.receiveJson({ type: "dbfile:download_start", id: "g1", token: "groups", chunkSize: 2 })
    assert.equal(Buffer.from(lastBinary(staff)).toString("utf8"), "ok")

    const verified = new FakeSocketClient()
    server.socket.addClient(verified, {
      user: { _id: "u4", groups: [], emailVerified: true },
      userId: "u4"
    })
    await verified.receiveJson({ type: "dbfile:download_start", id: "v1", token: "verified", chunkSize: 2 })
    assert.equal(Buffer.from(lastBinary(verified)).toString("utf8"), "ok")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("file module marks interrupted upload failed and removes temp file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "db-state-files-"))
  try {
    const mongo = createMemoryMongo()
    const files = createFileModule({ storage: root, chunkSize: 3 })
    const server = createDbStateServer({
      mongo,
      tables: [],
      files,
      now: clock(["2026-05-21T10:00:01.000Z", "2026-05-21T10:00:02.000Z"]),
      createLogId: idSeq()
    })
    const client = new FakeSocketClient()
    server.socket.addClient(client, { user: { _id: "u1", groups: [] }, userId: "u1" })

    await client.receiveJson({
      type: "dbfile:upload_start",
      id: "broken",
      name: "broken.txt",
      mime: "text/plain",
      size: 5,
      policy: { mode: "registered" }
    })
    await client.receiveBinary(Buffer.from("hel"))
    await client.close()

    const stored = await mongo.collection("file").findOne({ status: "failed" })
    assert.equal(stored.name, "broken.txt")
    await assert.rejects(() => readFile(path.join(root, "tmp", "broken.tmp")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

class FakeSocketClient {
  sent = []
  listeners = new Map()

  on(event, listener) {
    this.listeners.set(event, listener)
  }

  send(raw) {
    this.sent.push(raw)
  }

  async receiveJson(message) {
    await this.listeners.get("message")?.(JSON.stringify(message))
  }

  async receiveBinary(buffer) {
    await this.listeners.get("message")?.(buffer)
  }

  async close() {
    await this.listeners.get("close")?.()
  }
}

async function seedStoredFile(root, mongo, token, policy) {
  const storageKey = `files/${token.slice(0, 2)}/${token.slice(2, 4)}/${token}.file`
  const fullPath = path.join(root, ...storageKey.split("/"))
  await mkdir(path.dirname(fullPath), { recursive: true })
  await writeFile(fullPath, "ok")
  await mongo.collection("file").insertOne({
    _id: `file_${token}`,
    ownerId: "u1",
    token,
    name: `${token}.txt`,
    mime: "text/plain",
    size: 2,
    storageKey,
    status: "ready",
    downloadPolicy: policy
  })
}

function lastJson(client, type) {
  const raw = [...client.sent].reverse().find((item) => typeof item === "string" && JSON.parse(item).type === type)
  assert.ok(raw, `missing ${type}`)
  return JSON.parse(raw)
}

function lastBinary(client) {
  const raw = [...client.sent].reverse().find((item) => typeof item !== "string")
  assert.ok(raw, "missing binary frame")
  return raw
}

function createMemoryMongo() {
  const collections = new Map()
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new MemoryCollection())
      return collections.get(name)
    }
  }
}

class MemoryCollection {
  #items = []

  async findOne(filter) {
    return this.#items.find((item) => matches(item, filter)) ?? null
  }

  async updateOne(filter, update, options = {}) {
    let item = await this.findOne(filter)
    if (!item && options.upsert) {
      item = { _id: filter._id }
      this.#items.push(item)
    }
    if (item && update.$set) {
      for (const [key, value] of Object.entries(update.$set)) setByPath(item, key, value)
    }
    if (item && update.$unset) {
      for (const key of Object.keys(update.$unset)) unsetByPath(item, key)
    }
    return { acknowledged: true }
  }

  async insertOne(item) {
    this.#items.push(clone(item))
    return { insertedId: item._id }
  }

  async deleteOne(filter) {
    this.#items = this.#items.filter((item) => item._id !== filter._id)
    return { deletedCount: 1 }
  }

  find(filter = {}) {
    let items = this.#items.filter((item) => matches(item, filter))
    return {
      sort() {
        items = [...items].sort((a, b) => String(a._id).localeCompare(String(b._id)))
        return this
      },
      skip(count) {
        if (count > 0) items = items.slice(count)
        return this
      },
      limit(count) {
        if (count > 0) items = items.slice(0, count)
        return this
      },
      async toArray() {
        return items.map(clone)
      }
    }
  }
}

function matches(item, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    const value = item[key]
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$ne" in expected && value === expected.$ne) return false
      if ("$gt" in expected && !(value > expected.$gt)) return false
      if ("$lte" in expected && !(value <= expected.$lte)) return false
      return true
    }
    return value === expected
  })
}

function clock(values) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

function idSeq() {
  let index = 0
  return () => `id_${++index}`
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}
