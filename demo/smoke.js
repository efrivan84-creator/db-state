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

  // Чтение одного документа: маржа скрыта read_fields группы.
  const loaded = await rpc(ws, messages, "load", { table: "order", id: "o1" })
  assert.deepEqual(loaded, {
    _id: "o1",
    number: 1001,
    status: "новый",
    client: "ООО Ромашка",
    total: 1200,
    comment: "Позвонить до обеда"
  })

  // Списки, счётчик и уникальные значения.
  const ids = await rpc(ws, messages, "getIds", { table: "order", sort: { number: 1 } })
  assert.deepEqual(ids, ["o1", "o2", "o3", "o4"])
  assert.equal(await rpc(ws, messages, "count", { table: "order", filter: {} }), 4)
  assert.equal(await rpc(ws, messages, "count", { table: "order", filter: { client: "ООО Ромашка" } }), 2)
  const statuses = await rpc(ws, messages, "getUnique", { table: "order", field: "status" })
  assert.deepEqual([...statuses].sort(), ["в архиве", "в работе", "новый"])

  // Поле вне read_fields не отдаётся даже через getUnique.
  assert.deepEqual(await rpc(ws, messages, "getUnique", { table: "order", field: "margin" }), [])

  // Запись разрешённых полей.
  await rpc(ws, messages, "update", {
    table: "order",
    id: "o1",
    set: { status: "в работе" },
    sessionId: "smoke_manager"
  })

  // write_fields: поле вне списка отклоняет операцию целиком.
  await assert.rejects(
    () => rpc(ws, messages, "update", {
      table: "order",
      id: "o1",
      set: { margin: 999 },
      sessionId: "smoke_manager"
    }),
    /Write denied: field margin/
  )

  // sync: изменения приходят без скрытых полей.
  const sync = await rpc(ws, messages, "sync", { from: syncFrom, sessionId: "smoke_reader" })
  assert.equal(sync.changes.some((change) => change.set?.margin), false)
  assert.ok(sync.changes.length > 0)

  // Хук beforeWrite запрещает архивный заказ — своей причиной, не общей.
  await assert.rejects(
    () => rpc(ws, messages, "update", {
      table: "order",
      id: "o2",
      set: { status: "новый" },
      sessionId: "smoke_manager"
    }),
    /Архивный заказ изменять нельзя/
  )

  // Хук нормализует статус до записи.
  await rpc(ws, messages, "update", {
    table: "order",
    id: "o1",
    set: { status: "  НОВЫЙ  " },
    sessionId: "smoke_manager"
  })
  assert.equal((await rpc(ws, messages, "load", { table: "order", id: "o1" })).status, "новый")

  // Именованный RPC-метод сервера: менеджеру он доступен (write есть).
  const next = await rpc(ws, messages, "order.next-number", {})
  assert.equal(next.number, 1005)

  // Создать заказ менеджер не может: write_fields разрешает только
  // status и comment, а add пишет ещё number, client и total.
  await assert.rejects(
    () => rpc(ws, messages, "add", {
      table: "order",
      obj: { number: next.number, status: "новый", client: "АО Тест", total: 10 },
      sessionId: "smoke_manager"
    }),
    /Write denied: field/
  )

  // Неизвестная таблица отклоняется.
  await assert.rejects(
    () => rpc(ws, messages, "getIds", { table: "secret" }),
    /Unknown db-state table/
  )

  ws.close()

  // Руководитель: те же хуки, но полный доступ к полям.
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

  // Маржа видна руководителю.
  const adminView = await rpc(adminWs, adminMessages, "load", { table: "order", id: "o1" })
  assert.equal(adminView.margin, 340)

  // Запрет из хука сильнее прав группы: у руководителя на order полный доступ.
  await assert.rejects(
    () => rpc(adminWs, adminMessages, "update", {
      table: "order",
      id: "o2",
      set: { status: "новый" },
      sessionId: "smoke_admin"
    }),
    /Архивный заказ изменять нельзя/
  )

  // Хук ограничил limit сверху: просим 999, получаем не больше 50.
  const adminIds = await rpc(adminWs, adminMessages, "getIds", {
    table: "order",
    filter: {},
    limit: 999
  })
  assert.ok(adminIds.length <= 50 && adminIds.length === 4, `ids: ${JSON.stringify(adminIds)}`)

  // Создание и удаление доступны руководителю: у него нет ограничения полей.
  const nextAdmin = await rpc(adminWs, adminMessages, "order.next-number", {})
  const created = await rpc(adminWs, adminMessages, "add", {
    table: "order",
    obj: { number: nextAdmin.number, status: "новый", client: "АО Тест", total: 10, margin: 2 },
    sessionId: "smoke_admin"
  })
  assert.equal(created.ok, true)
  assert.equal(await rpc(adminWs, adminMessages, "count", { table: "order", filter: {} }), 5)

  const removed = await rpc(adminWs, adminMessages, "remove", {
    table: "order",
    id: created.id,
    sessionId: "smoke_admin"
  })
  assert.equal(removed.ok, true)
  assert.equal(await rpc(adminWs, adminMessages, "count", { table: "order", filter: {} }), 4)

  // Восстановление сессии по hash, без пароля.
  const authWs = new WebSocket(`ws://127.0.0.1:${port}/db-state/ws`)
  const authMessages = []
  authWs.on("message", (raw) => authMessages.push(JSON.parse(String(raw))))
  await onceOpen(authWs)
  const restored = await system(authWs, authMessages, "dbstate:auth", {
    userId: adminLogin.userId,
    hash: adminLogin.hash
  })
  assert.equal(restored.ok, true)
  assert.equal(restored.userId, "u_admin")
  authWs.close()

  // Неверный пароль отклоняется.
  const badWs = new WebSocket(`ws://127.0.0.1:${port}/db-state/ws`)
  const badMessages = []
  badWs.on("message", (raw) => badMessages.push(JSON.parse(String(raw))))
  await onceOpen(badWs)
  const badId = idValue()
  badWs.send(JSON.stringify({ type: "dbstate:login", id: badId, login: "admin", password: "wrong" }))
  const badLogin = await waitFor(badMessages, ["dbstate:login_result", "dbstate:login_error"], badId)
  assert.equal(badLogin.type, "dbstate:login_error")
  badWs.close()

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
    if (output.includes("сервер demo db-state")) return
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
