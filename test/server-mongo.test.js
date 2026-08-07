import assert from "node:assert/strict"
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { setByPath, unsetByPath } from "../packages/core/src/index.js"
import { accessAllows, createDbStateServer, mergeUserAccess } from "../packages/server-mongo/src/index.js"

test("server update writes data, appends log, broadcasts to everyone, and sync excludes current session", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["user"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1",
    changesBroadcastDelay: 0,
    changesBroadcastRate: 1000
  })
  await allowTable(mongo, "user", "admins")
  const writerSent = []
  const readerSent = []
  server.socket.addClient({ send: (message) => writerSent.push(JSON.parse(message)) }, { sessionId: "s1" })
  server.socket.addClient({ send: (message) => readerSent.push(JSON.parse(message)) }, { sessionId: "s2" })

  const update = await server.update({
    table: "user",
    id: "u1",
    set: { name: "Ivan" },
    sessionId: "s1",
    req: adminReq()
  })

  assert.equal(update.ok, true)
  assert.deepEqual(await mongo.collection("user").findOne({ _id: "u1" }), {
    _id: "u1",
    name: "Ivan",
    info: {
      editid: "u-admin",
      editdata: "2026-05-21T10:00:01.000Z"
    }
  })
  const [log] = await mongo.collection("log").find({}).toArray()
  assert.equal(log.userId, "u-admin")
  assert.equal("user" in log, false)
  await waitFor(() =>
    writerSent.some((message) => message.type === "dbstate:changes_available") &&
    readerSent.some((message) => message.type === "dbstate:changes_available")
  )

  const ownSync = await server.sync({
    from: "2026-05-21T10:00:00.000Z",
    sessionId: "s1",
    req: adminReq()
  })
  const remoteSync = await server.sync({
    from: "2026-05-21T10:00:00.000Z",
    sessionId: "s2",
    req: adminReq()
  })

  assert.deepEqual(ownSync.changes, [])
  assert.deepEqual(remoteSync.changes.map((change) => change.id), ["u1"])
})

test("sync reads complete twelve-hour windows and tells the client when more time remains", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: () => "2026-05-02T00:00:00.000Z"
  })
  const log = mongo.collection("log")
  for (const [logId, createdAt] of [
    ["log1", "2026-05-01T06:00:00.000Z"],
    ["log2", "2026-05-01T11:59:59.999Z"],
    ["log3", "2026-05-01T18:00:00.000Z"]
  ]) {
    await log.insertOne({
      _id: logId,
      logId,
      createdAt,
      table: "order",
      id: logId,
      action: "insert",
      obj: { _id: logId }
    })
  }
  const req = { user: { _id: "u1", access: { fullaccess: 1 } } }

  const first = await server.sync({
    from: "2026-05-01T00:00:00.000Z",
    sessionId: "reader",
    req
  })
  const second = await server.sync({
    from: first.to,
    sessionId: "reader",
    req
  })

  assert.equal(first.to, "2026-05-01T12:00:00.000Z")
  assert.equal(first.hasMore, true)
  assert.deepEqual(first.changes.map((change) => change.id), ["log1", "log2"])
  assert.equal(second.to, "2026-05-02T00:00:00.000Z")
  assert.equal(second.hasMore, undefined)
  assert.deepEqual(second.changes.map((change) => change.id), ["log3"])
})

test("sync requests a cache reset only when the cursor is more than twenty days old", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: () => "2026-06-01T00:00:00.000Z"
  })
  const req = { user: { _id: "u1", access: { fullaccess: 1 } } }

  const exactBoundary = await server.sync({
    from: "2026-05-12T00:00:00.000Z",
    req
  })
  const expired = await server.sync({
    from: "2026-05-11T23:59:59.999Z",
    req
  })

  assert.equal(exactBoundary.reset, undefined)
  assert.equal(exactBoundary.hasMore, true)
  assert.equal(exactBoundary.to, "2026-05-12T12:00:00.000Z")
  assert.deepEqual(expired, {
    to: "2026-06-01T00:00:00.000Z",
    changes: [],
    reset: true
  })
})

test("server debounces change broadcasts", async () => {
  const mongo = createMemoryMongo()
  const sent = []
  const server = createDbStateServer({
    mongo,
    tables: ["user"],
    changesBroadcastDelay: 30,
    changesBroadcastRate: 1000,
    now: clock(["2026-05-21T10:00:01.000Z", "2026-05-21T10:00:02.000Z"]),
    createLogId: idSeq()
  })
  await allowTable(mongo, "user", "admins")
  server.socket.addClient({ send: (message) => sent.push(JSON.parse(message)) }, { sessionId: "s1" })

  await server.update({ table: "user", id: "u1", set: { name: "Ivan" }, sessionId: "s1", req: adminReq() })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await server.update({ table: "user", id: "u2", set: { name: "Anna" }, sessionId: "s2", req: adminReq() })
  await new Promise((resolve) => setTimeout(resolve, 25))

  assert.equal(sent.filter((message) => message.type === "dbstate:changes_available").length, 0)

  await waitFor(() => sent.filter((message) => message.type === "dbstate:changes_available").length === 1)
})

test("server cancels an active rate-limited broadcast when a new change arrives", async () => {
  const mongo = createMemoryMongo()
  const sent = [[], [], []]
  const server = createDbStateServer({
    mongo,
    tables: ["user"],
    changesBroadcastDelay: 0,
    changesBroadcastRate: 5,
    now: clock(["2026-05-21T10:00:01.000Z", "2026-05-21T10:00:02.000Z"]),
    createLogId: idSeq()
  })
  await allowTable(mongo, "user", "admins")
  for (const bucket of sent) {
    server.socket.addClient({ send: (message) => bucket.push(JSON.parse(message)) }, { sessionId: `s${sent.indexOf(bucket)}` })
  }

  await server.update({ table: "user", id: "u1", set: { name: "Ivan" }, sessionId: "s1", req: adminReq() })
  await waitFor(() => sent[0].some((message) => message.type === "dbstate:changes_available"))

  await server.update({ table: "user", id: "u2", set: { name: "Anna" }, sessionId: "s2", req: adminReq() })
  await new Promise((resolve) => setTimeout(resolve, 120))

  assert.equal(sent[1].some((message) => message.type === "dbstate:changes_available"), false)
  assert.equal(sent[2].some((message) => message.type === "dbstate:changes_available"), false)
})

test("delete log stores old document and compact actor id", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order", "_user", "_group"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1"
  })
  await mongo.collection("order").insertOne({
    _id: "o1",
    status: "open"
  })

  await server.remove({
    table: "order",
    id: "o1",
    sessionId: "s1",
    req: {
      user: {
        _id: "u-admin",
        login: "ivan",
        groups: ["admins"],
        access: { order: { read: {}, write: {} } },
        hash: "secret-auth-hash",
        passwordHash: "secret-password-hash"
      }
    }
  })

  const [log] = await mongo.collection("log").find({}).toArray()
  assert.deepEqual(log.old, { _id: "o1", status: "open" })
  assert.equal(log.userId, "u-admin")
  assert.equal("user" in log, false)
})

test("legacy id is used as the key but never stored in the document", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1"
  })

  const result = await server.add({
    table: "order",
    obj: { id: "o1", status: "новый" },
    req: adminReq()
  })

  assert.equal(result.id, "o1")
  assert.deepEqual(await mongo.collection("order").findOne({ _id: "o1" }), {
    _id: "o1",
    status: "новый",
    info: { makeid: "u-admin", makedata: "2026-05-21T10:00:01.000Z" }
  })
})

test("login result carries the login field the user signed in with", async () => {
  const mongo = createMemoryMongo()
  await mongo.collection("_user").insertOne({
    _id: "u1",
    email: "ivan@example.com",
    passwordHash: "demo:secret",
    hash: "h1",
    groups: []
  })
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    authLoginFields: ["login", "email"],
    password: {
      hash: async (password) => `demo:${password}`,
      verify: async (password, stored) => stored === `demo:${password}`
    }
  })
  const sent = []
  const client = { send: (message) => sent.push(JSON.parse(message)) }
  server.socket.addClient(client, {})

  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:login",
    id: "L1",
    login: "ivan@example.com",
    password: "secret"
  }))

  // У пользователя нет поля login — подставляется email, по которому он вошёл.
  const login = sent.find((message) => message.id === "L1")
  assert.equal(login.type, "dbstate:login_result")
  assert.equal(login.login, "ivan@example.com")

  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:auth",
    id: "A1",
    userId: "u1",
    hash: "h1"
  }))

  assert.equal(sent.find((message) => message.id === "A1").login, "ivan@example.com")
})

test("add strips client info and writes server create info", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1"
  })
  await allowTable(mongo, "order", "admins")

  const result = await server.add({
    table: "order",
    obj: {
      _id: "o1",
      status: "open",
      info: {
        makeid: "client",
        makedata: "client-date",
        editid: "client-edit"
      }
    },
    sessionId: "s1",
    req: adminReq()
  })

  assert.deepEqual(await mongo.collection("order").findOne({ _id: "o1" }), {
    _id: "o1",
    status: "open",
    info: {
      makeid: "u-admin",
      makedata: "2026-05-21T10:00:01.000Z"
    }
  })
  assert.deepEqual(result.change.obj.info, {
    makeid: "u-admin",
    makedata: "2026-05-21T10:00:01.000Z"
  })
})

test("numericIds gives new documents sequential _id per table", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order", "bill"],
    numericIds: true,
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1"
  })
  await mongo.collection("_group").insertOne({
    _id: "admins",
    access: { order: { read: {}, write: {} }, bill: { read: {}, write: {} } }
  })

  const first = await server.add({ table: "order", obj: { status: "open" }, sessionId: "s1", req: adminReq() })
  const second = await server.add({ table: "order", obj: { status: "open" }, sessionId: "s1", req: adminReq() })
  // Счётчик отдельный на каждую таблицу — нумерация bill начинается заново.
  const other = await server.add({ table: "bill", obj: { sum: 10 }, sessionId: "s1", req: adminReq() })

  assert.equal(first.id, 1)
  assert.equal(second.id, 2)
  assert.equal(other.id, 1)
  assert.equal((await mongo.collection("order").findOne({ _id: 2 })).status, "open")
  // Ключ в журнале тот же, что у документа.
  assert.equal(second.change.id, 2)
})

test("numericIds keeps an _id sent by the client and does not spend a number", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    numericIds: true,
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1"
  })
  await allowTable(mongo, "order", "admins")

  const own = await server.add({ table: "order", obj: { _id: 100, status: "open" }, sessionId: "s1", req: adminReq() })
  const next = await server.add({ table: "order", obj: { status: "open" }, sessionId: "s1", req: adminReq() })

  assert.equal(own.id, 100)
  assert.equal(next.id, 1)
})

test("numericIds as a list numbers only the listed tables", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order", "bill"],
    numericIds: ["order"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "uuid-1"
  })
  await mongo.collection("_group").insertOne({
    _id: "admins",
    access: { order: { read: {}, write: {} }, bill: { read: {}, write: {} } }
  })

  const numbered = await server.add({ table: "order", obj: { status: "open" }, sessionId: "s1", req: adminReq() })
  const plain = await server.add({ table: "bill", obj: { sum: 10 }, sessionId: "s1", req: adminReq() })

  assert.equal(numbered.id, 1)
  assert.equal(plain.id, "uuid-1")
})

test("counter collection follows the service prefix and can be overridden", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    prefix: "shop",
    tables: ["order"],
    numericIds: true,
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1"
  })
  await mongo.collection("shop_group").insertOne({
    _id: "admins",
    access: { order: { read: {}, write: {} } }
  })

  await server.add({ table: "order", obj: { status: "open" }, sessionId: "s1", req: adminReq() })

  assert.equal((await mongo.collection("shop_counter").findOne({ _id: "order" })).seq, 1)
})

test("update strips client info and writes server edit info", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1"
  })
  await allowTable(mongo, "order", "admins")
  await mongo.collection("order").insertOne({
    _id: "o1",
    status: "open",
    info: {
      makeid: "u-admin",
      makedata: "2026-05-21T09:00:00.000Z"
    }
  })

  const result = await server.update({
    table: "order",
    id: "o1",
    set: {
      status: "done",
      info: { makeid: "client" },
      "info.editid": "client",
      "info.note": "client"
    },
    unset: ["info.makedata", "info.any"],
    sessionId: "s1",
    req: adminReq()
  })

  assert.deepEqual(await mongo.collection("order").findOne({ _id: "o1" }), {
    _id: "o1",
    status: "done",
    info: {
      makeid: "u-admin",
      makedata: "2026-05-21T09:00:00.000Z",
      editid: "u-admin",
      editdata: "2026-05-21T10:00:01.000Z"
    }
  })
  assert.deepEqual(result.change.set, {
    status: "done",
    "info.editid": "u-admin",
    "info.editdata": "2026-05-21T10:00:01.000Z"
  })
  assert.equal(result.change.unset, undefined)
})

test("internal writes without a user use system actor metadata", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1",
    // Системные записи сервера проходят без прав группы.
    hooks: {
      beforeWrite: (ctx) => (ctx.req?.__internal === true ? true : undefined)
    }
  })

  const add = await server.add({
    table: "order",
    obj: { _id: "o1", status: "open" },
    sessionId: "s1",
    req: { __internal: true }
  })

  const update = await server.update({
    table: "order",
    id: "o1",
    set: { status: "done" },
    sessionId: "s1",
    req: { __internal: true }
  })

  assert.deepEqual(await mongo.collection("order").findOne({ _id: "o1" }), {
    _id: "o1",
    status: "done",
    info: {
      makeid: "system",
      makedata: "2026-05-21T10:00:01.000Z",
      editid: "system",
      editdata: "2026-05-21T10:00:01.000Z"
    }
  })
  assert.equal(add.change.userId, "system")
  assert.equal(add.change.obj.info.makeid, "system")
  assert.equal(update.change.userId, "system")
  assert.equal(update.change.set["info.editid"], "system")
})

test("socket hub exposes custom events without sending reserved dbstate messages from users", () => {
  const sent = []
  const server = createDbStateServer({
    mongo: createMemoryMongo(),
    tables: ["user"]
  })

  const client = {
    send(message) {
      sent.push(JSON.parse(message))
    }
  }

  const unsubscribe = server.socket.addClient(client, { userId: "u1", sessionId: "s1" })
  server.socket.sendToUser("u1", "notify", { text: "hello" })
  unsubscribe()
  server.socket.sendToUser("u1", "notify", { text: "ignored" })

  assert.deepEqual(sent.map((message) => message.type), ["dbstate:hello", "notify"])
})

test("socket RPC handles db-state methods over WebSocket", async () => {
  const sent = []
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["user"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1"
  })
  await allowTable(mongo, "user", "admins")
  const client = {
    send(message) {
      sent.push(JSON.parse(message))
    }
  }

  server.socket.addClient(client, { user: { _id: "u1", groups: ["admins"], access: { user: { read: {}, write: {} } } }, userId: "u1", sessionId: "s1" })
  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:rpc",
    id: "rpc1",
    method: "update",
    payload: {
      table: "user",
      id: "u1",
      set: { name: "Ivan" },
      sessionId: "s1"
    }
  }))

  const response = sent.find((message) => message.type === "dbstate:rpc_result")
  assert.equal(response.id, "rpc1")
  assert.equal(response.result.ok, true)
  assert.deepEqual(await server.load({ table: "user", id: "u1", req: adminReq() }), {
    _id: "u1",
    name: "Ivan",
    info: {
      editid: "u1",
      editdata: "2026-05-21T10:00:01.000Z"
    }
  })
})

test("socket login returns user hash and auth enables RPC", async () => {
  const sent = []
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["user"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1",
    password: {
      hash: async (password) => `hashed:${password}`,
      verify: async (password, hash) => hash === `hashed:${password}`
    },
    createAuthHash: () => "auth-hash-1"
  })
  await allowTable(mongo, "user", "admins")
  await mongo.collection("_user").insertOne({
    _id: "u1",
    login: "ivan",
    passwordHash: "hashed:secret",
    groups: ["admins"],
    disabled: false
  })

  const client = {
    send(message) {
      sent.push(JSON.parse(message))
    }
  }

  server.socket.addClient(client, { sessionId: "s1" })
  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:login",
    id: "login1",
    login: "ivan",
    password: "secret"
  }))

  const loginResult = sent.find((message) => message.type === "dbstate:login_result")
  assert.equal(loginResult.userId, "u1")
  assert.equal(loginResult.hash, "auth-hash-1")
  assert.deepEqual(loginResult.access, { user: { read: {}, write: {} } })

  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:auth",
    id: "auth1",
    userId: "u1",
    hash: "auth-hash-1"
  }))

  const authResult = sent.find((message) => message.type === "dbstate:auth_result")
  assert.equal(authResult.ok, true)

  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:rpc",
    id: "rpc1",
    method: "update",
    payload: {
      table: "user",
      id: "u2",
      set: { name: "Anna" },
      sessionId: "s1"
    }
  }))

  const rpcResult = sent.find((message) => message.type === "dbstate:rpc_result")
  assert.equal(rpcResult.result.ok, true)
})

test("socket RPC never discloses how many rows read access hid", async () => {
  const sent = []
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"]
  })
  await mongo.collection("order").insertOne({ _id: "o1", status: "open" })
  await mongo.collection("order").insertOne({ _id: "o2", status: "closed" })
  const client = {
    send(message) {
      sent.push(JSON.parse(message))
    }
  }

  const user = { _id: "u1", groups: [], access: { order: { read: { status: "open" } } } }
  server.socket.addClient(client, { user, userId: "u1", sessionId: "s1" })
  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:rpc",
    id: "ids1",
    method: "getIds",
    payload: { table: "order", sort: { _id: 1 } }
  }))
  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:rpc",
    id: "count1",
    method: "count",
    payload: { table: "order" }
  }))

  const ids = sent.find((message) => message.id === "ids1")
  const count = sent.find((message) => message.id === "count1")
  assert.deepEqual(ids.result, ["o1"])
  assert.equal(count.result, 1)
  // Сколько строк скрыто — не дело клиента, и ради этого ничего не считается.
  assert.equal(ids.meta, undefined)
  assert.equal(count.meta, undefined)
})

test("socket RPC marks load responses with fields filtered by read fields", async () => {
  const sent = []
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    // Динамическое ограничение полей — ctx.fields в хуке.
    hooks: {
      beforeRead: (ctx) => {
        if (ctx.table === "order") ctx.fields = ["status"]
      }
    }
  })
  await mongo.collection("order").insertOne({ _id: "o1", status: "open", margin: 120 })
  const client = {
    send(message) {
      sent.push(JSON.parse(message))
    }
  }

  const user = { _id: "u1", groups: [], access: { order: { read: {} } } }
  server.socket.addClient(client, { user, userId: "u1", sessionId: "s1" })
  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:rpc",
    id: "load1",
    method: "load",
    payload: { table: "order", id: "o1" }
  }))

  const load = sent.find((message) => message.id === "load1")
  assert.deepEqual(load.result, { _id: "o1", status: "open" })
  assert.deepEqual(load.meta, { fieldsFiltered: true })
})

test("socket RPC marks sync responses with fields filtered by read fields", async () => {
  const sent = []
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: clock(["2026-05-21T10:00:01.000Z", "2026-05-21T10:00:02.000Z"])
  })
  await mongo.collection("order").insertOne({ _id: "o1", status: "open", margin: 120 })
  await server.update({
    table: "order",
    id: "o1",
    set: { status: "done", margin: 180 },
    sessionId: "writer",
    req: adminReq()
  })
  const client = {
    send(message) {
      sent.push(JSON.parse(message))
    }
  }

  // Постоянный список видимых полей — read_fields в правах группы.
  const user = { _id: "u1", groups: [], access: { order: { read: {}, read_fields: ["status"] } } }
  server.socket.addClient(client, { user, userId: "u1", sessionId: "reader" })
  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:rpc",
    id: "sync1",
    method: "sync",
    payload: { from: "2026-05-21T10:00:00.000Z", sessionId: "reader" }
  }))

  const sync = sent.find((message) => message.id === "sync1")
  assert.deepEqual(sync.result.changes.map((change) => change.set), [{ status: "done" }])
  assert.deepEqual(sync.meta, { fieldsFiltered: true })
})

test("socket login reuses existing user hash across tabs", async () => {
  const sent = []
  const mongo = createMemoryMongo()
  let hashCount = 0
  const server = createDbStateServer({
    mongo,
    tables: ["user"],
    password: {
      hash: async (password) => `hashed:${password}`,
      verify: async (password, hash) => hash === `hashed:${password}`
    },
    createAuthHash: () => `auth-hash-${++hashCount}`
  })
  await mongo.collection("_user").insertOne({
    _id: "u1",
    login: "ivan",
    passwordHash: "hashed:secret",
    groups: [],
    disabled: false
  })

  const client1 = { send: (message) => sent.push(JSON.parse(message)) }
  const client2 = { send: (message) => sent.push(JSON.parse(message)) }
  server.socket.addClient(client1, { sessionId: "tab1" })
  server.socket.addClient(client2, { sessionId: "tab2" })

  await server.socket.handleMessage(client1, JSON.stringify({
    type: "dbstate:login",
    id: "login1",
    login: "ivan",
    password: "secret"
  }))
  await server.socket.handleMessage(client2, JSON.stringify({
    type: "dbstate:login",
    id: "login2",
    login: "ivan",
    password: "secret"
  }))

  const first = sent.find((message) => message.id === "login1")
  const second = sent.find((message) => message.id === "login2")
  assert.equal(first.hash, "auth-hash-1")
  assert.equal(second.hash, "auth-hash-1")
  assert.equal(hashCount, 1)

  await server.socket.handleMessage(client1, JSON.stringify({
    type: "dbstate:auth",
    id: "auth1",
    userId: "u1",
    hash: first.hash
  }))

  const authResult = sent.find((message) => message.id === "auth1")
  assert.equal(authResult.ok, true)
})

test("socket login can match configured user fields", async () => {
  const sent = []
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["user"],
    authLoginFields: ["login", "name", "email", "phone"],
    password: {
      hash: async (password) => `hashed:${password}`,
      verify: async (password, hash) => hash === `hashed:${password}`
    },
    createAuthHash: () => "auth-hash"
  })
  await mongo.collection("_user").insertOne({
    _id: "u1",
    name: "Ivan",
    email: "ivan@example.com",
    phone: "+79990001122",
    passwordHash: "hashed:secret",
    groups: ["admins"],
    disabled: false
  })

  for (const login of ["Ivan", "ivan@example.com", "+79990001122"]) {
    const client = { send: (message) => sent.push(JSON.parse(message)) }
    server.socket.addClient(client, { sessionId: login })
    await server.socket.handleMessage(client, JSON.stringify({
      type: "dbstate:login",
      id: login,
      login,
      password: "secret"
    }))
  }

  assert.deepEqual(
    sent.filter((message) => message.type === "dbstate:login_result").map((message) => message.userId),
    ["u1", "u1", "u1"]
  )
})

test("socket login normalizes configured user fields", async () => {
  const sent = []
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["user"],
    authLoginFields: ["email", "phone"],
    normalizeAuthLogin: (value, field) => {
      const text = String(value).trim()
      if (field === "email") return text.toLowerCase()
      if (field === "phone") return text.replace(/\D/g, "")
      return text
    },
    password: {
      hash: async (password) => `hashed:${password}`,
      verify: async (password, hash) => hash === `hashed:${password}`
    },
    createAuthHash: () => "auth-hash"
  })
  await mongo.collection("_user").insertOne({
    _id: "u1",
    email: "ivan@example.com",
    phone: "79990001122",
    passwordHash: "hashed:secret",
    disabled: false
  })

  for (const login of [" IVAN@Example.COM ", "+7 (999) 000-11-22"]) {
    const client = { send: (message) => sent.push(JSON.parse(message)) }
    server.socket.addClient(client, { sessionId: login })
    await server.socket.handleMessage(client, JSON.stringify({
      type: "dbstate:login",
      id: login,
      login,
      password: "secret"
    }))
  }

  assert.deepEqual(
    sent.filter((message) => message.type === "dbstate:login_result").map((message) => message.userId),
    ["u1", "u1"]
  )
})

test("socket login rejects ambiguous normalized identifiers and reports a warning", async () => {
  const sent = []
  const warnings = []
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["user"],
    authLoginFields: ["email"],
    normalizeAuthLogin: (value) => String(value).trim().toLowerCase(),
    onAuthWarning: (warning) => warnings.push(warning),
    password: {
      hash: async (password) => `hashed:${password}`,
      verify: async (password, hash) => hash === `hashed:${password}`
    }
  })
  await mongo.collection("_user").insertOne({
    _id: "u1",
    email: "ivan@example.com",
    passwordHash: "hashed:secret",
    disabled: false
  })
  await mongo.collection("_user").insertOne({
    _id: "u2",
    email: "ivan@example.com",
    passwordHash: "hashed:secret",
    disabled: false
  })

  const client = { send: (message) => sent.push(JSON.parse(message)) }
  server.socket.addClient(client, { sessionId: "s1" })
  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:login",
    id: "login1",
    login: "IVAN@example.com",
    password: "secret"
  }))

  const error = sent.find((message) => message.type === "dbstate:login_error")
  assert.equal(error.error, "Invalid login or password")
  assert.deepEqual(warnings.map((warning) => warning.type), ["ambiguous_auth_login"])
  assert.equal(client.user, undefined)
})

test("socket login can be rejected by authRateLimit", async () => {
  const sent = []
  const calls = []
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["user"],
    authRateLimit: (ctx) => {
      calls.push(ctx)
      return false
    }
  })

  const client = { send: (message) => sent.push(JSON.parse(message)) }
  server.socket.addClient(client, { sessionId: "s1" })
  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:login",
    id: "login1",
    login: "ivan",
    password: "secret"
  }))

  const error = sent.find((message) => message.type === "dbstate:login_error")
  assert.equal(error.error, "Too many attempts")
  assert.equal(calls[0].type, "login")
  assert.equal(calls[0].login, "ivan")
})

test("socket hash auth can be rejected by authRateLimit", async () => {
  const sent = []
  const calls = []
  const server = createDbStateServer({
    mongo: createMemoryMongo(),
    tables: ["user"],
    authRateLimit: (ctx) => {
      calls.push(ctx)
      return false
    }
  })

  const client = { send: (message) => sent.push(JSON.parse(message)) }
  server.socket.addClient(client, { sessionId: "s1" })
  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:auth",
    id: "auth1",
    userId: "u1",
    hash: "auth-hash"
  }))

  const error = sent.find((message) => message.type === "dbstate:auth_error")
  assert.equal(error.error, "Too many attempts")
  assert.equal(calls[0].type, "auth")
  assert.equal(calls[0].userId, "u1")
})

test("server-mongo entrypoint exports auth helpers", async () => {
  const module = await import("../packages/server-mongo/src/index.js")

  assert.equal(typeof module.defaultPassword.hash, "function")
  assert.equal(typeof module.defaultPassword.verify, "function")
  assert.equal(typeof module.defaultAuthHash, "function")
  assert.equal(typeof module.hashValue, "function")
})

test("socket RPC is denied before auth", async () => {
  const sent = []
  const server = createDbStateServer({
    mongo: createMemoryMongo(),
    tables: ["user"]
  })
  const client = {
    send(message) {
      sent.push(JSON.parse(message))
    }
  }

  server.socket.addClient(client, { sessionId: "s1" })
  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:rpc",
    id: "rpc1",
    method: "sync",
    payload: {
      from: "1970-01-01T00:00:00.000Z",
      sessionId: "s1"
    }
  }))

  const error = sent.find((message) => message.type === "dbstate:rpc_error")
  assert.equal(error.error, "Unauthorized")
})

test("permissions default to deny when neither code rules nor user access decide", async () => {
  const server = createDbStateServer({
    mongo: createMemoryMongo(),
    tables: ["user"]
  })

  await assert.rejects(
    () => server.update({ table: "user", id: "u1", set: { name: "Ivan" }, req: { user: { _id: "u1", groups: [] } } }),
    /Write denied/
  )
})

test("service tables are readable when listed explicitly and granted", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order", "_group"]
  })

  await mongo.collection("_group").insertOne({
    _id: "g_admin",
    name: "Admins"
  })

  assert.deepEqual(await server.load({ table: "_group", id: "g_admin", req: adminReq() }), {
    _id: "g_admin",
    name: "Admins"
  })
})

test("mergeUserAccess merges group access and personal access additively", async () => {
  const mongo = createMemoryMongo()
  await mongo.collection("_group").insertOne({ _id: "managers", access: { order: { read: {} } } })
  await mongo.collection("_group").insertOne({ _id: "cashiers", access: { pay: { read: {}, write: {} } } })

  const access = await mergeUserAccess(
    { mongo, groupTable: "_group" },
    { _id: "u1", groups: ["managers", "cashiers"], access: { order: { write: {} } } }
  )

  assert.deepEqual(access, { order: { read: {}, write: {} }, pay: { read: {}, write: {} } })
})

test("access read filter limits rows and read_fields projects documents", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["admin"]
  })
  await mongo.collection("admin").insertOne({ _id: "a1", fio: "Иван", tel: "111", enable: true, pass: "x" })
  await mongo.collection("admin").insertOne({ _id: "a2", fio: "Пётр", tel: "222", enable: false, pass: "y" })

  const req = {
    user: {
      _id: "u1",
      groups: [],
      access: { admin: { read: { enable: true }, read_fields: ["fio", "tel"] } }
    }
  }

  // Виден только включённый сотрудник и только разрешённые поля.
  assert.deepEqual(await server.load({ table: "admin", id: "a1", req }), { _id: "a1", fio: "Иван", tel: "111" })
  await assert.rejects(() => server.load({ table: "admin", id: "a2", req }), /Read denied/)
  // Несуществующий id при фильтрованном праве — тоже отказ, а не null.
  await assert.rejects(() => server.load({ table: "admin", id: "a3", req }), /Read denied/)
  assert.deepEqual(await server.getIds({ table: "admin", filter: {}, req }), ["a1"])
  assert.equal(await server.count({ table: "admin", filter: {}, req }), 1)
})

test("empty field whitelists expose only ids and deny client writes", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({ mongo, tables: ["admin"] })
  await mongo.collection("_group").insertOne({
    _id: "limited",
    access: {
      admin: {
        read: {},
        read_fields: [],
        write: {},
        write_fields: []
      }
    }
  })
  await mongo.collection("admin").insertOne({ _id: "a1", id: "legacy-a1", fio: "Иван", pass: "secret" })

  const access = await mergeUserAccess(
    { mongo, groupTable: "_group" },
    { _id: "u1", groups: ["limited"] }
  )
  assert.deepEqual(access.admin.read_fields, [])
  assert.deepEqual(access.admin.write_fields, [])
  const req = { user: { _id: "u1", groups: ["limited"], access } }

  assert.deepEqual(await server.load({ table: "admin", id: "a1", req }), { _id: "a1" })
  assert.deepEqual(await server.getIds({ table: "admin", filter: { _id: "a1" }, req }), ["a1"])
  await assert.rejects(
    () => server.getIds({ table: "admin", filter: { fio: "Иван" }, req }),
    /Read denied: field fio/
  )
  await assert.rejects(
    () => server.update({ table: "admin", id: "a1", set: { fio: "Пётр" }, req }),
    /Write denied: field fio/
  )
})

test("beforeRead can explicitly narrow visible fields to an empty list", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["admin"],
    hooks: {
      beforeRead(ctx) {
        ctx.fields = []
        return true
      }
    }
  })
  await mongo.collection("admin").insertOne({ _id: "a1", fio: "Иван" })

  assert.deepEqual(
    await server.load({ table: "admin", id: "a1", req: { user: { _id: "u1" } } }),
    { _id: "a1" }
  )
  await assert.rejects(
    () => server.getIds({
      table: "admin",
      filter: { fio: "Иван" },
      req: { user: { _id: "u1" } }
    }),
    /Read denied: field fio/
  )
})

test("read_fields blocks filtering and sorting by hidden fields", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({ mongo, tables: ["admin"] })
  await mongo.collection("admin").insertOne({ _id: "a1", fio: "Иван", enable: true, pass: "secret" })

  const req = {
    user: {
      _id: "u1",
      groups: [],
      access: { admin: { read: {}, read_fields: ["fio"] } }
    }
  }

  // pass не отдаётся в ответе — и фильтровать по нему тоже нельзя:
  // иначе значение подбирается перебором по наличию строк в результате.
  await assert.rejects(
    () => server.getIds({ table: "admin", filter: { pass: "secret" }, req }),
    /Read denied: field pass/
  )
  await assert.rejects(
    () => server.getIds({ table: "admin", filter: { id: "a1" }, req }),
    /Read denied: field id/
  )
  await assert.rejects(
    () => server.count({ table: "admin", filter: { pass: "secret" }, req }),
    /Read denied: field pass/
  )
  // Оператор сравнения ничего не меняет.
  await assert.rejects(
    () => server.getIds({ table: "admin", filter: { pass: { $regex: "^s" } }, req }),
    /Read denied: field pass/
  )
  // Как и вложенность в логический оператор.
  await assert.rejects(
    () => server.getIds({ table: "admin", filter: { $or: [{ fio: "Иван" }, { pass: "secret" }] }, req }),
    /Read denied: field pass/
  )
  await assert.rejects(
    () => server.getUnique({ table: "admin", field: "fio", filter: { pass: "secret" }, req }),
    /Read denied: field pass/
  )
  await assert.rejects(
    () => server.getIds({ table: "admin", filter: {}, sort: { pass: 1 }, req }),
    /Read denied: field pass/
  )
  // Operators whose field dependencies cannot be derived statically are
  // rejected instead of being mistaken for field-free filters.
  for (const [operator, filter] of [
    ["$expr", { $expr: { $eq: ["$pass", "secret"] } }],
    ["$where", { $where: "this.pass === 'secret'" }],
    ["$text", { $text: { $search: "secret" } }],
    ["$jsonSchema", { $jsonSchema: { required: ["pass"] } }]
  ]) {
    await assert.rejects(
      () => server.getIds({ table: "admin", filter, req }),
      new RegExp(`Read denied: field \\${operator}`)
    )
  }

  // По разрешённому полю фильтр работает как раньше.
  assert.deepEqual(await server.getIds({ table: "admin", filter: { fio: "Иван" }, req }), ["a1"])
  assert.deepEqual(await server.getIds({ table: "admin", filter: { fio: { $in: ["Иван"] } }, req }), ["a1"])
  assert.deepEqual(await server.getIds({ table: "admin", filter: { _id: "a1" }, sort: { _id: 1 }, req }), ["a1"])
  // Право без ограничения полей фильтруется по чему угодно.
  const full = { user: { _id: "u2", groups: [], access: { admin: { read: {} } } } }
  assert.deepEqual(await server.getIds({ table: "admin", filter: { pass: "secret" }, req: full }), ["a1"])
})

test("access write filter checks the existing document and write_fields limit writes", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["zad"]
  })
  await mongo.collection("zad").insertOne({ _id: 1, status: "open", fio: "A", comm: "" })
  await mongo.collection("zad").insertOne({ _id: 2, status: "closed", fio: "B", comm: "" })

  const req = {
    user: {
      _id: "u1",
      groups: [],
      access: { zad: { read: {}, write: { status: "open" }, write_fields: ["comm"] } }
    }
  }

  // Открытую заявку можно комментировать, но только в разрешённое поле.
  const ok = await server.update({ table: "zad", id: 1, set: { comm: "готово" }, req })
  assert.equal(ok.ok, true)
  await assert.rejects(
    () => server.update({ table: "zad", id: 1, set: { fio: "X" }, req }),
    /Write denied: field fio/
  )
  // Закрытая заявка не проходит write-фильтр.
  await assert.rejects(
    () => server.update({ table: "zad", id: 2, set: { comm: "нельзя" }, req }),
    /Write denied/
  )
  await assert.rejects(() => server.remove({ table: "zad", id: 2, req }), /Write denied/)
})

test("access filter placeholders $adminid and $groupid match the current user", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["zad"]
  })
  await mongo.collection("zad").insertOne({ _id: 1, master: "u1", dep: "north" })
  await mongo.collection("zad").insertOne({ _id: 2, master: "u2", dep: "south" })
  await mongo.collection("zad").insertOne({ _id: 3, master: "u3", dep: "north" })

  const mine = { user: { _id: "u1", groups: ["north"], access: { zad: { read: { master: "$adminid" } } } } }
  assert.deepEqual(await server.getIds({ table: "zad", filter: {}, req: mine }), [1])

  const myDep = { user: { _id: "u1", groups: ["north"], access: { zad: { read: { dep: "$groupid" } } } } }
  assert.deepEqual(await server.getIds({ table: "zad", filter: {}, req: myDep }), [1, 3])
})

test("mergeUserAccess combines filters as any-of and drops field limits when one grant is unlimited", async () => {
  const mongo = createMemoryMongo()
  await mongo.collection("_group").insertOne({
    _id: "a",
    access: { zad: { read: { dep: "north" }, read_fields: ["fio"] } }
  })
  await mongo.collection("_group").insertOne({
    _id: "b",
    access: { zad: { read: { dep: "south" } } }
  })

  const access = await mergeUserAccess(
    { mongo, groupTable: "_group" },
    { _id: "u1", groups: ["a", "b"] }
  )

  // Два фильтра из разных групп = any-of; группа b читает без ограничения полей —
  // ограничение снимается целиком.
  assert.deepEqual(access, { zad: { read: [{ dep: "north" }, { dep: "south" }] } })

  const server = createDbStateServer({ mongo, tables: ["zad"] })
  await mongo.collection("zad").insertOne({ _id: 1, dep: "north" })
  await mongo.collection("zad").insertOne({ _id: 2, dep: "south" })
  await mongo.collection("zad").insertOne({ _id: 3, dep: "west" })
  const req = { user: { _id: "u1", groups: ["a", "b"], access } }
  assert.deepEqual(await server.getIds({ table: "zad", filter: {}, req }), [1, 2])
})

test("sync loads the changed document lazily for filtered access", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["zad"],
    now: clock(["2026-05-21T10:00:01.000Z", "2026-05-21T10:00:02.000Z", "2026-05-21T10:00:03.000Z"]),
    createLogId: idSeq()
  })
  const writer = { user: { _id: "w1", groups: [], access: { zad: { read: {}, write: {} } } } }
  await server.add({ table: "zad", obj: { _id: 1, dep: "north" }, sessionId: "writer", req: writer })
  await server.add({ table: "zad", obj: { _id: 2, dep: "south" }, sessionId: "writer", req: writer })

  const sync = await server.sync({
    from: "2026-05-21T10:00:00.000Z",
    sessionId: "reader",
    req: { user: { _id: "u1", groups: [], access: { zad: { read: { dep: "north" } } } } }
  })

  assert.deepEqual(sync.changes.map((change) => change.id), [1])
})

test("user access from groups gates read and write per action after login", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    password: {
      hash: async (password) => `p:${password}`,
      verify: async (password, hash) => hash === `p:${password}`
    }
  })
  await mongo.collection("_group").insertOne({ _id: "managers", access: { order: { read: {} } } })
  await mongo.collection("_user").insertOne({ _id: "m1", login: "manager", passwordHash: "p:secret", groups: ["managers"] })
  await mongo.collection("order").insertOne({ _id: "o1", status: "open" })

  const sent = []
  const client = { send: (message) => sent.push(JSON.parse(message)) }
  server.socket.addClient(client, { sessionId: "s1" })
  await server.socket.handleMessage(client, JSON.stringify({ type: "dbstate:login", id: "l1", login: "manager", password: "secret" }))
  assert.deepEqual(sent.find((message) => message.type === "dbstate:login_result").access, { order: { read: {} } })

  await server.socket.handleMessage(client, JSON.stringify({ type: "dbstate:rpc", id: "r1", method: "load", payload: { table: "order", id: "o1" } }))
  assert.deepEqual(sent.find((message) => message.type === "dbstate:rpc_result" && message.id === "r1").result, { _id: "o1", status: "open" })

  await server.socket.handleMessage(client, JSON.stringify({ type: "dbstate:rpc", id: "r2", method: "update", payload: { table: "order", id: "o1", set: { status: "done" } } }))
  assert.match(sent.find((message) => message.type === "dbstate:rpc_error" && message.id === "r2").error, /Write denied/)
})

test("read fields project load and sync changes", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: clock([
      "2026-05-21T10:00:01.000Z",
      "2026-05-21T10:00:02.000Z",
      "2026-05-21T10:00:03.000Z"
    ]),
    createLogId: idSeq()
  })

  await server.add({
    table: "order",
    obj: { _id: "o1", status: "open", total: 100, margin: 30 },
    sessionId: "writer",
    req: adminReq()
  })
  await server.update({
    table: "order",
    id: "o1",
    set: { status: "done", margin: 40 },
    sessionId: "writer",
    req: adminReq()
  })
  await server.update({
    table: "order",
    id: "o1",
    set: { margin: 50 },
    sessionId: "writer",
    req: adminReq()
  })

  // Менеджер видит только status и total — read_fields в правах группы.
  const req = {
    user: {
      _id: "m1",
      groups: ["manager"],
      access: { order: { read: {}, read_fields: ["status", "total"] } }
    }
  }

  assert.deepEqual(await server.load({ table: "order", id: "o1", req }), {
    _id: "o1",
    status: "done",
    total: 100
  })

  const sync = await server.sync({
    from: "2026-05-21T10:00:00.000Z",
    sessionId: "reader",
    req
  })

  assert.deepEqual(sync.changes, [
    {
      logId: "log1",
      createdAt: "2026-05-21T10:00:01.000Z",
      table: "order",
      id: "o1",
      action: "insert",
      set: undefined,
      unset: undefined,
      obj: { _id: "o1", status: "open", total: 100 },
      old: undefined,
      sessionId: "writer",
      userId: "u-admin"
    },
    {
      logId: "log2",
      createdAt: "2026-05-21T10:00:02.000Z",
      table: "order",
      id: "o1",
      action: "update",
      set: { status: "done" },
      unset: undefined,
      obj: undefined,
      old: undefined,
      sessionId: "writer",
      userId: "u-admin"
    }
  ])
})

test("access rights only accept filter objects, other values deny", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({ mongo, tables: ["zad"] })
  await mongo.collection("zad").insertOne({ _id: "z1", ownerId: "u1" })

  for (const read of [false, 0, 1, true, "yes", [], [1, "x"], null]) {
    const req = { user: { _id: "u1", groups: [], access: { zad: { read } } } }
    assert.deepEqual(
      await server.getIds({ table: "zad", filter: {}, req }),
      [],
      `read: ${JSON.stringify(read)} must not grant access`
    )
    assert.equal(accessAllows({ zad: { read } }, "zad", "read"), false)
  }

  const granted = { user: { _id: "u1", groups: [], access: { zad: { read: {} } } } }
  assert.deepEqual(await server.getIds({ table: "zad", filter: {}, req: granted }), ["z1"])
})

test("merging groups ignores non-filter rights", async () => {
  const mongo = createMemoryMongo()
  await mongo.collection("_group").insertOne({ _id: "g1", access: { zad: { read: true, write: 1 } } })
  await mongo.collection("_group").insertOne({ _id: "g2", access: { zad: { read: { city: "msk" } } } })

  const access = await mergeUserAccess(
    { mongo, groupTable: "_group" },
    { _id: "u1", groups: ["g1", "g2"] }
  )

  assert.deepEqual(access, { zad: { read: { city: "msk" } } })
  assert.equal(accessAllows(access, "zad", "write"), false)
})

test("reads resolve the user once regardless of row count", async () => {
  const mongo = createMemoryMongo()
  let userCalls = 0
  const server = createDbStateServer({
    mongo,
    tables: ["zad"],
    access: { zad: { read: () => true } },
    getUser: async ({ req }) => {
      userCalls += 1
      return req?.user
    }
  })
  for (const id of ["z1", "z2", "z3"]) await mongo.collection("zad").insertOne({ _id: id })

  const ids = await server.getIds({ table: "zad", filter: {}, req: adminReq() })

  assert.deepEqual(ids, ["z1", "z2", "z3"])
  assert.equal(userCalls, 1)
})

test("getIds applies skip before limit", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"]
  })
  await allowTable(mongo, "order", "admins")

  await mongo.collection("order").insertOne({ _id: "o1" })
  await mongo.collection("order").insertOne({ _id: "o2" })
  await mongo.collection("order").insertOne({ _id: "o3" })
  await mongo.collection("order").insertOne({ _id: "o4" })

  const ids = await server.getIds({
    table: "order",
    sort: { _id: 1 },
    skip: 1,
    limit: 2,
    req: adminReq()
  })

  assert.deepEqual(ids, ["o2", "o3"])
})

test("sync does not load changed documents for table-level access decisions", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1"
  })

  await server.add({
    table: "order",
    obj: { _id: "o1", status: "open", total: 100 },
    sessionId: "writer",
    req: { user: { _id: "m1", groups: [], access: { order: { read: {}, write: {} } } } }
  })

  mongo.collection("order").findOneCalls = 0

  const sync = await server.sync({
    from: "2026-05-21T10:00:00.000Z",
    sessionId: "reader",
    req: { user: { _id: "m2", groups: [], access: { order: { read: {} } } } }
  })

  assert.deepEqual(sync.changes.map((change) => change.id), ["o1"])
  assert.equal(mongo.collection("order").findOneCalls, 0)
})

test("sync loads a filtered document from the database once", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1"
  })
  await server.add({
    table: "order",
    obj: { _id: "o1", status: "open" },
    sessionId: "writer",
    req: { user: { _id: "admin", groups: ["admin"], access: { order: { write: {} } } } }
  })

  mongo.collection("order").findOneCalls = 0

  const sync = await server.sync({
    from: "2026-05-21T10:00:00.000Z",
    sessionId: "reader",
    req: { user: { _id: "m1", groups: [], access: { order: { read: { status: "open" } } } } }
  })

  assert.deepEqual(sync.changes.map((change) => change.id), ["o1"])
  assert.equal(mongo.collection("order").findOneCalls, 1)
})

test("hooks allow and deny across tables without group access", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order", "product"],
    hooks: {
      // Один хук на весь сервер, таблица разбирается внутри.
      beforeRead: (ctx) => (ctx.table === "product" ? true : undefined),
      beforeWrite: (ctx) => {
        if (ctx.table !== "order") return
        return { allowed: false, reason: "Заказы правит только менеджер" }
      }
    }
  })

  await mongo.collection("product").insertOne({ _id: "p1", title: "Box" })

  // beforeRead вернул true — access группы не нужен.
  assert.deepEqual(
    await server.load({ table: "product", id: "p1", req: { user: { _id: "guest", groups: [] } } }),
    { _id: "p1", title: "Box" }
  )

  // Хук молчит на order — решает access группы, которого нет.
  await assert.rejects(
    () => server.load({ table: "order", id: "o1", req: { user: { _id: "guest", groups: [] } } }),
    /Read denied: order/
  )

  // Явный запрет с причиной доходит до клиента.
  await assert.rejects(
    () => server.update({
      table: "order",
      id: "o1",
      set: { status: "open" },
      req: { user: { _id: "admin", groups: [], access: { fullaccess: 1 } } }
    }),
    /Заказы правит только менеджер/
  )
})

test("read hooks can prefilter queries and observe results", async () => {
  const mongo = createMemoryMongo()
  const events = []
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    hooks: {
      beforeRead: async (ctx) => {
        events.push(`before:${ctx.table}:${ctx.method}`)
        // Правка фильтра применяется, хотя решение оставлено access группы.
        ctx.filter = { ...ctx.filter, status: "open", ownerId: ctx.user._id }
      },
      afterRead: async (ctx) => {
        events.push(`after:${ctx.result.length}`)
      }
    }
  })
  await mongo.collection("order").insertOne({ _id: "o1", status: "open", ownerId: "u1" })
  await mongo.collection("order").insertOne({ _id: "o2", status: "closed", ownerId: "u1" })
  await mongo.collection("order").insertOne({ _id: "o3", status: "open", ownerId: "u2" })

  const ids = await server.getIds({
    table: "order",
    filter: {},
    req: { user: { _id: "u1", groups: [], access: { order: { read: {} } } } }
  })

  assert.deepEqual(ids, ["o1"])
  assert.deepEqual(events, ["before:order:getIds", "after:1"])
})

test("write hooks can mutate writes and observe appended changes", async () => {
  const mongo = createMemoryMongo()
  const events = []
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: idSeq(),
    hooks: {
      beforeWrite: async (ctx) => {
        events.push(`before:${ctx.table}:${ctx.action}`)
        ctx.set.status = String(ctx.set.status).toLowerCase()
        ctx.set.hook = true
      },
      afterWrite: async (ctx) => {
        events.push(`after:${ctx.change.action}:${ctx.change.id}`)
      }
    }
  })

  await server.update({
    table: "order",
    id: "o1",
    set: { status: "OPEN" },
    req: { user: { _id: "u1", groups: [], access: { order: { write: {} } } } }
  })

  assert.deepEqual(await mongo.collection("order").findOne({ _id: "o1" }), {
    _id: "o1",
    status: "open",
    hook: true,
    info: {
      editid: "u1",
      editdata: "2026-05-21T10:00:01.000Z"
    }
  })
  assert.deepEqual(events, ["before:order:update", "after:update:o1"])
})

test("error hooks run for failed reads and writes without swallowing errors", async () => {
  const mongo = createMemoryMongo()
  const events = []
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    hooks: {
      errorRead: async (ctx) => events.push(`read:${ctx.method}:${ctx.error.message}`),
      errorWrite: async (ctx) => events.push(`write:${ctx.method}:${ctx.error.message}`)
    }
  })

  await assert.rejects(
    () => server.load({ table: "order", id: "o1", req: { user: { _id: "u1", groups: [] } } }),
    /Read denied/
  )
  await assert.rejects(
    () => server.update({
      table: "order",
      id: "o1",
      set: { status: "open" },
      req: { user: { _id: "u1", groups: [] } }
    }),
    /Write denied/
  )

  // Обращение к таблице вне tables тоже доходит до error-хука.
  await assert.rejects(
    () => server.getIds({ table: "hack", req: { user: { _id: "u1", groups: [] } } }),
    /Unknown db-state table/
  )

  assert.deepEqual(events, [
    "read:load:Read denied: order",
    "write:update:Write denied: order",
    "read:getIds:Unknown db-state table: hack"
  ])
})

test("write fields reject forbidden update fields", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: clock(["2026-05-21T10:00:01.000Z", "2026-05-21T10:00:02.000Z"]),
    createLogId: idSeq()
  })
  // Менеджеру разрешена только колонка status — списком полей в правах группы.
  const manager = {
    user: {
      _id: "m1",
      groups: ["manager"],
      access: { order: { read: {}, write: {}, write_fields: ["status"] } }
    }
  }

  await mongo.collection("order").insertOne({
    _id: "o1",
    status: "open",
    margin: 30
  })
  await server.add({
    table: "order",
    obj: { _id: "o2", status: "open" },
    req: manager
  })

  await server.update({
    table: "order",
    id: "o1",
    set: { status: "done" },
    req: manager
  })

  await assert.rejects(
    () => server.update({
      table: "order",
      id: "o1",
      set: { margin: 40 },
      req: manager
    }),
    /Write denied: field margin/
  )
  await assert.rejects(
    () => server.add({
      table: "order",
      obj: { _id: "o3", status: "open", margin: 40 },
      req: manager
    }),
    /Write denied: field margin/
  )

  assert.equal((await mongo.collection("order").findOne({ _id: "o1" })).margin, 30)
  assert.equal((await mongo.collection("order").findOne({ _id: "o2" })).status, "open")
  assert.equal(await mongo.collection("order").findOne({ _id: "o3" }), null)
})

test("a hook decides before the user's group access", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    hooks: {
      beforeWrite: (ctx) => (ctx.table === "order" ? false : undefined)
    }
  })

  // Право группы полное, но хук запретил раньше.
  await assert.rejects(
    () => server.update({
      table: "order",
      id: "o1",
      set: { status: "open" },
      req: { user: { _id: "admin", groups: ["admin"], access: { order: { read: {}, write: {} } } } }
    }),
    /Write denied: order/
  )
})

test("server exposes custom RPC methods through options.methods", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["zad"],
    methods: {
      "zad.next-number": async ({ body, userId }) => ({ num: (body.from ?? 0) + 1, userId })
    }
  })
  const sent = []
  const client = { send: (message) => sent.push(JSON.parse(message)) }
  server.socket.addClient(client, { user: { _id: "u-admin", groups: ["admins"] }, userId: "u-admin", sessionId: "s1" })

  await server.socket.handleMessage(client, JSON.stringify({
    type: "dbstate:rpc",
    id: "r1",
    method: "zad.next-number",
    payload: { from: 41 }
  }))

  const result = sent.find((message) => message.type === "dbstate:rpc_result" && message.id === "r1")
  assert.deepEqual(result.result, { num: 42, userId: "u-admin" })
})

test("server merges custom RPC methods from modules", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: [],
    files: [{ methods: { "module.ping": async () => "pong" } }]
  })
  const sent = []
  const client = { send: (message) => sent.push(JSON.parse(message)) }
  server.socket.addClient(client, { user: { _id: "u1", groups: [] }, userId: "u1", sessionId: "s1" })

  await server.socket.handleMessage(client, JSON.stringify({ type: "dbstate:rpc", id: "r1", method: "module.ping", payload: {} }))

  const result = sent.find((message) => message.type === "dbstate:rpc_result" && message.id === "r1")
  assert.equal(result.result, "pong")
})

test("server rejects custom methods that collide with built-in RPC", () => {
  assert.throws(
    () => createDbStateServer({
      mongo: createMemoryMongo(),
      tables: ["zad"],
      methods: { load: async () => null }
    }),
    /already exists: load/
  )
})

test("methodsDir serves file-based methods and hot-reloads on mtime change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbstate-methods-"))
  await mkdir(join(dir, "zad"))
  const file = join(dir, "zad", "get-num.js")
  await writeFile(file, "export default async ({ body, db, user }) => ({ num: body.from + 1, db, userId: user._id })\n")

  const server = createDbStateServer({
    mongo: createMemoryMongo(),
    tables: [],
    methodsDir: dir,
    methodsContext: { db: "DB" }
  })
  const sent = []
  const client = { send: (message) => sent.push(JSON.parse(message)) }
  server.socket.addClient(client, { user: { _id: "u1", groups: [] }, userId: "u1", sessionId: "s1" })

  await server.socket.handleMessage(client, JSON.stringify({ type: "dbstate:rpc", id: "r1", method: "zad.get-num", payload: { from: 41 } }))
  const first = sent.find((message) => message.type === "dbstate:rpc_result" && message.id === "r1")
  assert.deepEqual(first.result, { num: 42, db: "DB", userId: "u1" })

  // Правка файла применяется без перезапуска: mtime изменился — файл перечитан.
  await writeFile(file, "export default async ({ body }) => ({ num: body.from + 100 })\n")
  await utimes(file, new Date(), new Date(Date.now() + 5000))

  await server.socket.handleMessage(client, JSON.stringify({ type: "dbstate:rpc", id: "r2", method: "zad.get-num", payload: { from: 41 } }))
  const second = sent.find((message) => message.type === "dbstate:rpc_result" && message.id === "r2")
  assert.deepEqual(second.result, { num: 141 })
})

test("methodsDir file methods receive db and api by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbstate-methods-"))
  await writeFile(
    join(dir, "check.js"),
    "export default async ({ db, api }) => ({ hasDb: typeof db.collection === \"function\", hasApi: typeof api.load === \"function\" })\n"
  )

  const server = createDbStateServer({ mongo: createMemoryMongo(), tables: [], methodsDir: dir })
  const sent = []
  const client = { send: (message) => sent.push(JSON.parse(message)) }
  server.socket.addClient(client, { user: { _id: "u1", groups: [] }, userId: "u1", sessionId: "s1" })

  await server.socket.handleMessage(client, JSON.stringify({ type: "dbstate:rpc", id: "r1", method: "check", payload: {} }))

  const reply = sent.find((message) => message.type === "dbstate:rpc_result" && message.id === "r1")
  assert.deepEqual(reply.result, { hasDb: true, hasApi: true })
})

test("methodsDir rejects method names that could leave the directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbstate-methods-"))
  await writeFile(join(dir, "ping.js"), "export default async () => \"pong\"\n")

  const server = createDbStateServer({
    mongo: createMemoryMongo(),
    tables: [],
    methodsDir: dir
  })
  const sent = []
  const client = { send: (message) => sent.push(JSON.parse(message)) }
  server.socket.addClient(client, { user: { _id: "u1", groups: [] }, userId: "u1", sessionId: "s1" })

  for (const [id, method] of [["r1", "..ping"], ["r2", "../ping"], ["r3", "zad..get"], ["r4", "PING"]]) {
    await server.socket.handleMessage(client, JSON.stringify({ type: "dbstate:rpc", id, method, payload: {} }))
    const reply = sent.find((message) => message.type === "dbstate:rpc_error" && message.id === id)
    assert.match(reply.error, /Unknown db-state RPC method/)
  }

  await server.socket.handleMessage(client, JSON.stringify({ type: "dbstate:rpc", id: "r5", method: "ping", payload: {} }))
  const ok = sent.find((message) => message.type === "dbstate:rpc_result" && message.id === "r5")
  assert.equal(ok.result, "pong")
})

test("custom RPC methods require an authenticated client", async () => {
  const server = createDbStateServer({
    mongo: createMemoryMongo(),
    tables: [],
    methods: { ping: async () => "pong" }
  })
  const sent = []
  const client = { send: (message) => sent.push(JSON.parse(message)) }
  server.socket.addClient(client, { sessionId: "s1" })

  await server.socket.handleMessage(client, JSON.stringify({ type: "dbstate:rpc", id: "r1", method: "ping", payload: {} }))

  const error = sent.find((message) => message.type === "dbstate:rpc_error" && message.id === "r1")
  assert.equal(error.error, "Unauthorized")
})

function createMemoryMongo() {
  const collections = new Map()

  const mongo = {
    collection(name) {
      if (!collections.has(name)) {
        collections.set(name, new MemoryCollection())
      }

      return collections.get(name)
    }
  }
  return mongo
}

class MemoryCollection {
  #items = []
  findOneCalls = 0

  async findOne(filter) {
    this.findOneCalls += 1
    return this.#items.find((item) => matches(item, filter)) ?? null
  }

  async updateOne(filter, update, options = {}) {
    let item = await this.findOne(filter)

    if (!item && options.upsert) {
      item = { _id: filter._id }
      this.#items.push(item)
    }

    if (item && update.$set) {
      for (const [path, value] of Object.entries(update.$set)) {
        setByPath(item, path, value)
      }
    }
    if (item && update.$unset) {
      for (const key of Object.keys(update.$unset)) {
        unsetByPath(item, key)
      }
    }

    return { acknowledged: true }
  }

  async insertOne(item) {
    this.#items.push({ ...item })
    return { insertedId: item._id }
  }

  async findOneAndUpdate(filter, update, options = {}) {
    let item = await this.findOne(filter)

    if (!item && options.upsert) {
      item = { _id: filter._id }
      this.#items.push(item)
    }
    if (!item) return null

    for (const [key, value] of Object.entries(update.$inc ?? {})) {
      item[key] = (item[key] ?? 0) + value
    }

    return options.returnDocument === "after" ? { ...item } : null
  }

  async deleteOne(filter) {
    this.#items = this.#items.filter((item) => item._id !== filter._id)
    return { deletedCount: 1 }
  }

  find(filter = {}) {
    let items = this.#items.filter((item) => matches(item, filter))

    return {
      sort() {
        items = [...items].sort((a, b) => {
          if ("createdAt" in a && "createdAt" in b) return a.createdAt.localeCompare(b.createdAt)
          return String(a._id).localeCompare(String(b._id))
        })
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
        return items.map((item) => ({ ...item }))
      }
    }
  }
}

async function allowTable(mongo, table, group) {
  await mongo.collection("_group").insertOne({
    _id: group,
    access: { [table]: { read: {}, write: {} } }
  })
}

function adminReq() {
  return { user: { _id: "u-admin", groups: ["admins"], access: { fullaccess: 1 } } }
}

function matches(item, filter = {}) {
  if (filter.$and) {
    const { $and, ...rest } = filter
    return matches(item, rest) && $and.every((part) => matches(item, part))
  }
  if (filter.$or) {
    const { $or, ...rest } = filter
    return matches(item, rest) && $or.some((part) => matches(item, part))
  }

  return Object.entries(filter).every(([key, expected]) => {
    const value = item[key]
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$in" in expected) return expected.$in.includes(value)
      if ("$gt" in expected && !(value > expected.$gt)) return false
      if ("$lte" in expected && !(value <= expected.$lte)) return false
      if ("$ne" in expected && value === expected.$ne) return false
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
  return () => `log${++index}`
}

async function waitFor(check) {
  for (let i = 0; i < 50; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(check(), true)
}
