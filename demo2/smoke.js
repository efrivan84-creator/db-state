import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

import WebSocket from "ws"

const port = 8788
const server = spawn(process.execPath, ["demo2/server/index.js"], {
  env: { ...process.env, DB_STATE_DEMO2_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
})

try {
  await waitForServer(server)

  const admin = await connect()
  const adminLogin = await system(admin.ws, admin.messages, "dbstate:login", {
    login: "admin",
    password: "admin"
  })
  assert.equal(adminLogin.userId, "u_admin")

  const userIds = await rpc(admin.ws, admin.messages, "getIds", {
    table: "_user",
    sort: { _id: 1 }
  })
  assert.deepEqual(userIds, ["u_admin", "u_manager", "u_viewer"])

  const manager = await connect()
  await system(manager.ws, manager.messages, "dbstate:login", {
    login: "manager",
    password: "manager"
  })

  const order = await rpc(manager.ws, manager.messages, "load", {
    table: "order",
    id: "o1"
  })
  assert.deepEqual(order, {
    _id: "o1",
    status: "open",
    total: 1200,
    comment: "First order",
    ownerId: "u_manager"
  })

  await assert.rejects(
    () => rpc(manager.ws, manager.messages, "update", {
      table: "order",
      id: "o1",
      set: { margin: 999 },
      sessionId: "smoke_manager"
    }),
    /Write denied: field margin/
  )

  await rpc(manager.ws, manager.messages, "update", {
    table: "order",
    id: "o1",
    set: { status: "done", comment: "Updated by manager" },
    sessionId: "smoke_manager"
  })

  const adminOrder = await rpc(admin.ws, admin.messages, "load", {
    table: "order",
    id: "o1"
  })
  assert.equal(adminOrder.margin, 340)
  assert.equal(adminOrder.status, "done")

  admin.ws.close()
  manager.ws.close()
  console.log("demo2 smoke ok")
} finally {
  server.kill()
}

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/db-state/ws`)
  const messages = []
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))))
  await onceOpen(ws)
  return { ws, messages }
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
    if (output.includes("db-state demo2 admin server")) return
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
