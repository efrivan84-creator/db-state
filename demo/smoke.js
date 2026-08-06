import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

import WebSocket from "ws"

const port = 8787
const server = spawn(process.execPath, ["demo/server/index.js"], {
  env: { ...process.env, DB_STATE_DEMO_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
})

try {
  await waitForServer(server)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/db-state/ws`)
  const messages = []

  ws.on("message", (raw) => {
    messages.push(JSON.parse(String(raw)))
  })

  await onceOpen(ws)

  const login = await system(ws, messages, "dbstate:login", {
    login: "manager",
    password: "manager"
  })
  assert.equal(login.userId, "u_manager")
  const syncFrom = new Date(Date.now() - 60_000).toISOString()

  const loaded = await rpc(ws, messages, "load", {
    table: "order",
    id: "o1"
  })
  assert.deepEqual(loaded, {
    _id: "o1",
    status: "open",
    total: 1200,
    comment: "Visible note"
  })

  await rpc(ws, messages, "update", {
    table: "order",
    id: "o1",
    set: { status: "done" },
    sessionId: "smoke_manager"
  })

  await assert.rejects(
    () => rpc(ws, messages, "update", {
      table: "order",
      id: "o1",
      set: { margin: 999 },
      sessionId: "smoke_manager"
    }),
    /Write denied: field margin/
  )

  const sync = await rpc(ws, messages, "sync", {
    from: syncFrom,
    sessionId: "smoke_reader"
  })
  assert.equal(sync.changes.some((change) => change.set?.margin), false)

  // Хук beforeWrite запрещает архивные заказы — своей причиной, не общей.
  await assert.rejects(
    () => rpc(ws, messages, "update", {
      table: "order",
      id: "o2",
      set: { status: "open" },
      sessionId: "smoke_manager"
    }),
    /Архивный заказ изменять нельзя/
  )

  // Хук нормализует статус до записи.
  await rpc(ws, messages, "update", {
    table: "order",
    id: "o1",
    set: { status: "OPEN" },
    sessionId: "smoke_manager"
  })
  const normalized = await rpc(ws, messages, "load", { table: "order", id: "o1" })
  assert.equal(normalized.status, "open")

  ws.close()

  // Админ: те же хуки, но полный доступ к полям.
  const adminWs = new WebSocket(`ws://127.0.0.1:${port}/db-state/ws`)
  const adminMessages = []
  adminWs.on("message", (raw) => adminMessages.push(JSON.parse(String(raw))))
  await onceOpen(adminWs)

  const adminLogin = await system(adminWs, adminMessages, "dbstate:login", {
    login: "admin",
    password: "admin"
  })
  assert.equal(adminLogin.userId, "u_admin")
  assert.deepEqual(adminLogin.access, { order: { read: {}, write: {} } })

  const adminView = await rpc(adminWs, adminMessages, "load", { table: "order", id: "o1" })
  assert.equal(adminView.margin, 340)

  // Запрет из хука сильнее прав группы: у админа fullaccess на order.
  await assert.rejects(
    () => rpc(adminWs, adminMessages, "update", {
      table: "order",
      id: "o2",
      set: { status: "open" },
      sessionId: "smoke_admin"
    }),
    /Архивный заказ изменять нельзя/
  )

  // Хук ограничил limit сверху: просим 999, получаем не больше 50.
  const ids = await rpc(adminWs, adminMessages, "getIds", {
    table: "order",
    filter: {},
    limit: 999
  })
  assert.ok(ids.length <= 50 && ids.length === 2, `ids: ${JSON.stringify(ids)}`)

  adminWs.close()
  console.log("demo smoke ok")
} finally {
  server.kill()
}

async function waitForServer(child) {
  let output = ""
  child.stdout.on("data", (chunk) => {
    output += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    output += String(chunk)
  })

  for (let i = 0; i < 50; i += 1) {
    if (output.includes("db-state demo server")) return
    if (child.exitCode != null) throw new Error(output || `server exited: ${child.exitCode}`)
    await delay(50)
  }

  throw new Error(`server did not start: ${output}`)
}

function onceOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
}

async function system(ws, messages, type, payload) {
  const id = idValue()
  ws.send(JSON.stringify({ type, id, ...payload }))
  return waitFor(messages, `${type}_result`, id)
}

async function rpc(ws, messages, method, payload) {
  const id = idValue()
  ws.send(JSON.stringify({ type: "dbstate:rpc", id, method, payload }))
  const response = await waitFor(messages, ["dbstate:rpc_result", "dbstate:rpc_error"], id)
  if (response.type === "dbstate:rpc_error") throw new Error(response.error)
  return response.result
}

async function waitFor(messages, type, id) {
  const types = Array.isArray(type) ? type : [type]

  for (let i = 0; i < 100; i += 1) {
    const message = messages.find((item) => item.id === id && types.includes(item.type))
    if (message) return message
    await delay(25)
  }

  throw new Error(`timeout waiting for ${types.join(", ")}:${id}`)
}

function idValue() {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`
}
