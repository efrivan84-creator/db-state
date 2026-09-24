import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createMemoryMongo } from "../demo/server/memoryMongo.js"
import { createFileModule, localFileStorage } from "../packages/server-files/src/index.js"
import { createDbStateServer } from "../packages/server-mongo/src/index.js"

// 0.3.8: бинарные фреймы не читаются как команды, дедупликация по SHA-256,
// sha256 и storageKey не покидают сервер, локальное хранилище читает только
// нужный диапазон.

class FakeSocketClient {
  sent = []
  listeners = new Map()
  on(event, listener) { this.listeners.set(event, listener) }
  send(raw) { this.sent.push(raw) }
  // Как ws: вторым аргументом — признак бинарного фрейма.
  async receiveJson(message) { await this.listeners.get("message")?.(JSON.stringify(message), false) }
  async receiveBinary(buffer, isBinary = true) { await this.listeners.get("message")?.(buffer, isBinary) }
}

function json(client) {
  return client.sent.filter((raw) => typeof raw === "string").map((raw) => JSON.parse(raw))
}

async function fileServer(moduleOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "db-state-dedupe-"))
  const mongo = createMemoryMongo({})
  const server = createDbStateServer({
    mongo,
    tables: [],
    files: createFileModule({ storage: root, chunkSize: 5, defaultPolicy: { mode: "registered" }, ...moduleOptions })
  })
  const connect = (userId) => {
    const client = new FakeSocketClient()
    server.socket.addClient(client, { user: { _id: userId, groups: [] }, userId, sessionId: `s-${userId}` })
    return client
  }
  // Загрузка целиком: upload_start, затем куски по запросам сервера.
  const upload = async (client, content, extra = {}) => {
    const bytes = Buffer.from(content)
    const id = `up-${Math.random()}`
    await client.receiveJson({ type: "dbfile:upload_start", id, name: "f.txt", mime: "text/plain", size: bytes.length, ...extra })
    for (;;) {
      const last = json(client).reverse().find((message) => message.id === id)
      if (!last || last.type !== "dbfile:upload_next") return last
      await client.receiveBinary(bytes.subarray(last.offset, last.offset + last.chunkSize))
    }
  }
  const download = async (client, token) => {
    client.sent.length = 0
    await client.receiveJson({ type: "dbfile:download_start", id: "dl", token, chunkSize: 5 })
    const chunks = []
    for (;;) {
      const error = json(client).find((message) => message.type === "dbfile:error")
      if (error) return { error: error.error }
      chunks.push(...client.sent.filter((raw) => typeof raw !== "string").map((raw) => Buffer.from(raw)))
      const done = json(client).some((message) => message.type === "dbfile:download_done")
      client.sent.length = 0
      if (done) return { content: Buffer.concat(chunks).toString() }
      await client.receiveJson({ type: "dbfile:download_next", id: "dl" })
    }
  }
  const stored = async () => (await filesIn(path.join(root, "files"))).length
  const rows = (filter) => mongo.collection("file").find(filter).toArray()
  return { mongo, server, connect, upload, download, stored, rows, done: () => rm(root, { recursive: true, force: true }) }
}

async function filesIn(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await filesIn(full))
    else out.push(full)
  }
  return out
}

const sha = (text) => createHash("sha256").update(text).digest("hex")

test("binary chunk that parses as JSON is still file data", async () => {
  const s = await fileServer()
  try {
    const client = s.connect("u1")
    // Кусок "12345" — корректное JSON-число, {} — объект, оба целиком в одном
    // куске (5 байт). Бинарный фрейм — всегда данные файла.
    const number = await s.upload(client, "12345")
    assert.equal(number.type, "dbfile:upload_done")
    assert.equal((await s.download(client, number.token)).content, "12345")
    const object = await s.upload(client, "{}")
    assert.equal(object.type, "dbfile:upload_done")
    assert.equal((await s.download(client, object.token)).content, "{}")
  } finally { await s.done() }
})

test("socket without the binary flag: only a JSON object is a command", async () => {
  const s = await fileServer()
  try {
    const client = s.connect("u1")
    await client.receiveJson({ type: "dbfile:upload_start", id: "u", name: "n.txt", mime: "text/plain", size: 5 })
    // Свой адаптер без признака бинарности: число — данные, не команда.
    await client.receiveBinary(Buffer.from("12345"), undefined)
    assert.ok(json(client).some((message) => message.type === "dbfile:upload_done" && message.id === "u"))
  } finally { await s.done() }
})

test("dedupe: a known hash links the stored file without sending bytes", async () => {
  const s = await fileServer()
  try {
    const content = "одинаковый файл"
    const first = await s.upload(s.connect("u1"), content, { sha256: sha(content) })
    assert.equal(first.type, "dbfile:upload_done")
    assert.equal(first.deduplicated, undefined)

    const other = s.connect("u2")
    other.sent.length = 0
    await other.receiveJson({ type: "dbfile:upload_start", id: "again", name: "копия.txt", mime: "text/plain",
      size: Buffer.byteLength(content), sha256: sha(content).toUpperCase(), policy: { mode: "public" } })
    // Ни одного запроса куска: байты не передавались.
    assert.equal(json(other).some((message) => message.type === "dbfile:upload_next"), false)
    const linked = json(other).find((message) => message.type === "dbfile:upload_done")
    assert.equal(linked.deduplicated, true)
    assert.notEqual(linked.token, first.token)
    assert.equal(linked.file.ownerId, "u2")
    assert.equal(linked.file.name, "копия.txt")
    assert.deepEqual(linked.file.downloadPolicy, { mode: "public" })

    const ready = await s.rows({ status: "ready" })
    assert.equal(ready.length, 2)
    assert.equal(ready[0].storageKey, ready[1].storageKey)
    assert.equal(await s.stored(), 1)
    assert.equal((await s.download(s.connect("u3"), linked.token)).content, content)
  } finally { await s.done() }
})

test("dedupe: the stored hash is the server's own, a wrong claim is rejected", async () => {
  const s = await fileServer()
  try {
    const client = s.connect("u1")
    // Заявлен хэш одного содержимого, прислано другое — не сохраняем.
    const lie = await s.upload(client, "мусор", { sha256: sha("чужой документ") })
    assert.equal(lie.type, "dbfile:error")
    assert.match(lie.error, /checksum mismatch/)
    assert.deepEqual(await s.rows({ status: "ready" }), [])
    assert.equal((await s.rows({ status: "failed" })).length, 1)
    assert.equal(await s.stored(), 0)

    // Хэш, под которым ничего не лежит, ссылкой не становится: обычная загрузка.
    const fresh = await s.upload(client, "новое", { sha256: sha("новое") })
    assert.equal(fresh.type, "dbfile:upload_done")
    assert.equal(fresh.deduplicated, undefined)
    assert.equal((await s.rows({ _id: fresh.fileId }))[0].sha256, sha("новое"))
  } finally { await s.done() }
})

test("dedupe: identical bytes uploaded without a hash are stored once", async () => {
  const s = await fileServer()
  try {
    const a = await s.upload(s.connect("u1"), "без хэша")
    const b = await s.upload(s.connect("u2"), "без хэша")
    assert.equal(b.deduplicated, undefined)
    const [ra] = await s.rows({ _id: a.fileId })
    const [rb] = await s.rows({ _id: b.fileId })
    assert.equal(ra.storageKey, rb.storageKey)
    assert.equal(await s.stored(), 1)
    assert.equal((await s.download(s.connect("u3"), b.token)).content, "без хэша")
  } finally { await s.done() }
})

test("dedupe: false keeps every upload separate", async () => {
  const s = await fileServer({ dedupe: false })
  try {
    await s.upload(s.connect("u1"), "раздельно", { sha256: sha("раздельно") })
    const second = await s.upload(s.connect("u2"), "раздельно", { sha256: sha("раздельно") })
    assert.equal(second.deduplicated, undefined)
    assert.equal(await s.stored(), 2)
  } finally { await s.done() }
})

test("sha256 and storageKey never leave the server: upload reply, load, sync", async () => {
  const s = await fileServer()
  try {
    const done = await s.upload(s.connect("u1"), "тайна", { sha256: sha("тайна") })
    const reply = JSON.stringify(done)
    assert.equal(reply.includes("sha256") || reply.includes(sha("тайна")) || reply.includes("storageKey"), false)
    const reader = { user: { _id: "u1", groups: [], access: { file: { read: {} } } } }
    const loaded = await s.server.load({ table: "file", id: done.fileId, req: reader })
    assert.equal("sha256" in loaded || "storageKey" in loaded, false)
    const { changes } = await s.server.sync({ from: new Date(Date.now() - 60_000).toISOString(), req: reader })
    const text = JSON.stringify(changes.filter((change) => change.table === "file"))
    assert.ok(text.includes(done.token))
    assert.equal(text.includes("sha256") || text.includes("storageKey") || text.includes(sha("тайна")), false)
  } finally { await s.done() }
})

test("local storage reads only the requested range", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "db-state-range-"))
  try {
    const storage = localFileStorage(root)
    await storage.writeChunk({ uploadId: "r", chunk: Buffer.from("0123456789") })
    const { storageKey } = await storage.finish({ uploadId: "r" })
    const read = async (range) => {
      const parts = []
      for await (const chunk of storage.read({ storageKey, range })) parts.push(Buffer.from(chunk))
      return Buffer.concat(parts).toString()
    }
    assert.equal(await read({ start: 2, end: 5 }), "234")
    assert.equal(await read({ start: 8 }), "89")
    assert.equal(await read({ start: 4, end: 4 }), "")
  } finally { await rm(root, { recursive: true, force: true }) }
})
