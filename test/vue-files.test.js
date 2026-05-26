import assert from "node:assert/strict"
import test from "node:test"

import { createDbState, createMemoryCache } from "../packages/vue/src/index.js"
import { createFileClient } from "../packages/vue-files/src/index.js"

test("vue file client registers state.file and uploads with server-driven chunks", async () => {
  const OriginalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = FakeWebSocket

  try {
    const state = createDbState({
      autoAuth: false,
      cache: createMemoryCache(),
      reconnectDelay: 0,
      safetySyncInterval: 0,
      ...testStorage(),
      tables: ["message"],
      wsUrl: "ws://example.test/db-state/ws"
    })
    const files = createFileClient(state)
    state.auth.status = "authorized"

    assert.ok(state.file)

    const progress = []
    const blob = new Blob(["hello"], { type: "text/plain" })
    blob.name = "a.txt"
    const uploadedPromise = files.upload(blob, {
      key: "message-form",
      policy: { mode: "registered" },
      onProgress: (item) => progress.push(item)
    })

    const ws = FakeWebSocket.instances.at(-1)
    await waitFor(() => ws.sent.length === 1)
    assert.equal(JSON.parse(ws.sent[0]).type, "dbfile:upload_start")
    const id = JSON.parse(ws.sent[0]).id

    ws.emitMessage({ type: "dbfile:upload_next", id, offset: 0, chunkSize: 3 })
    await waitFor(() => ws.sent.length === 2)
    assert.equal(await rawText(ws.sent[1]), "hel")

    ws.emitMessage({ type: "dbfile:upload_next", id, offset: 3, chunkSize: 2 })
    await waitFor(() => ws.sent.length === 3)
    assert.equal(await rawText(ws.sent[2]), "lo")

    ws.emitMessage({
      type: "dbfile:upload_done",
      id,
      fileId: "f1",
      token: "tok1",
      file: { _id: "f1", token: "tok1", name: "a.txt", mime: "text/plain", size: 5, status: "ready" }
    })
    const uploaded = await uploadedPromise

    assert.equal(uploaded.token, "tok1")
    assert.equal(uploaded.file.name, "a.txt")
    assert.deepEqual(progress.map((item) => item.loaded), [0, 3, 5])
  } finally {
    globalThis.WebSocket = OriginalWebSocket
    FakeWebSocket.instances = []
  }
})

test("vue file client downloads binary chunks by token", async () => {
  const OriginalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = FakeWebSocket

  try {
    const state = createDbState({
      autoAuth: false,
      cache: createMemoryCache(),
      reconnectDelay: 0,
      safetySyncInterval: 0,
      ...testStorage(),
      tables: [],
      wsUrl: "ws://example.test/db-state/ws"
    })
    const files = createFileClient(state)
    const ws = FakeWebSocket.instances.at(-1)

    const progress = []
    const downloadPromise = files.download("tok1", {
      onProgress: (item) => progress.push(item)
    })
    await waitFor(() => ws.sent.length === 1)
    assert.equal(JSON.parse(ws.sent[0]).type, "dbfile:download_start")
    const id = JSON.parse(ws.sent[0]).id

    ws.emitMessage({ type: "dbfile:download_info", id, name: "a.txt", mime: "text/plain", size: 5 })
    ws.emitBinary(new Uint8Array([104, 101]).buffer)
    await waitFor(() => ws.sent.length === 2)
    assert.deepEqual(JSON.parse(ws.sent[1]), { type: "dbfile:download_next", id, offset: 2 })

    ws.emitBinary(new Uint8Array([108, 108, 111]).buffer)
    await waitFor(() => ws.sent.length === 3)
    assert.deepEqual(JSON.parse(ws.sent[2]), { type: "dbfile:download_next", id, offset: 5 })

    ws.emitMessage({ type: "dbfile:download_done", id, name: "a.txt", mime: "text/plain", size: 5 })
    const blob = await downloadPromise
    assert.equal(await blob.text(), "hello")
    assert.equal(blob.type, "text/plain")
    assert.deepEqual(progress.map((item) => [item.loaded, item.total]), [[0, 5], [2, 5], [5, 5]])
  } finally {
    globalThis.WebSocket = OriginalWebSocket
    FakeWebSocket.instances = []
  }
})

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static instances = []

  readyState = FakeWebSocket.OPEN
  listeners = new Map()
  sent = []

  constructor() {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(handler)
  }

  send(raw) {
    this.sent.push(raw)
  }

  emitMessage(message) {
    for (const handler of this.listeners.get("message") ?? []) {
      handler({ data: JSON.stringify(message) })
    }
  }

  emitBinary(buffer) {
    for (const handler of this.listeners.get("message") ?? []) {
      handler({ data: buffer })
    }
  }

  close() {
    this.readyState = 3
    for (const handler of this.listeners.get("close") ?? []) handler({ type: "close" })
  }
}

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

async function rawText(raw) {
  if (raw?.arrayBuffer) return Buffer.from(await raw.arrayBuffer()).toString("utf8")
  return Buffer.from(raw).toString("utf8")
}
