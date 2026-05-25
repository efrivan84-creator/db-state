import assert from "node:assert/strict"
import test from "node:test"

import { setByPath, unsetByPath } from "../packages/core/src/index.js"
import { createDbStateServer } from "../packages/server-mongo/src/index.js"

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
    tables: ["order"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1"
  })
  await allowTable(mongo, "order", "admins")
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

  server.socket.addClient(client, { user: { _id: "u1", groups: ["admins"] }, userId: "u1", sessionId: "s1" })
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

test("permissions default to deny when no code rule or _permission rule decides", async () => {
  const server = createDbStateServer({
    mongo: createMemoryMongo(),
    tables: ["user"]
  })

  await assert.rejects(
    () => server.update({ table: "user", id: "u1", set: { name: "Ivan" }, req: adminReq() }),
    /Write denied/
  )
})

test("service tables are available through normal permissions", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"]
  })

  await allowTable(mongo, "_group", "admins")
  await mongo.collection("_group").insertOne({
    _id: "g_admin",
    name: "Admins"
  })

  assert.deepEqual(await server.load({ table: "_group", id: "g_admin", req: adminReq() }), {
    _id: "g_admin",
    name: "Admins"
  })
})

test("_permission if rules allow matching user groups and filter sync changes", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: clock(["2026-05-21T10:00:01.000Z", "2026-05-21T10:00:02.000Z", "2026-05-21T10:00:03.000Z"]),
    createLogId: idSeq()
  })

  await mongo.collection("_permission").insertOne({
    _id: "perm_order_open",
    table: "order",
    priority: 10,
    if: { status: "open" },
    read: { groups: ["manager"] },
    write: { groups: ["admin"] }
  })

  await server.update({
    table: "order",
    id: "o1",
    set: { status: "open" },
    sessionId: "writer",
    req: { user: { _id: "admin", groups: ["admin"] } }
  })

  const managerSync = await server.sync({
    from: "2026-05-21T10:00:00.000Z",
    sessionId: "reader",
    req: { user: { _id: "m1", groups: ["manager"] } }
  })
  const guestSync = await server.sync({
    from: "2026-05-21T10:00:00.000Z",
    sessionId: "reader",
    req: { user: { _id: "g1", groups: ["guest"] } }
  })

  assert.deepEqual(managerSync.changes.map((change) => change.id), ["o1"])
  assert.deepEqual(guestSync.changes, [])
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

  await mongo.collection("_permission").insertOne({
    _id: "perm_order_manager",
    table: "order",
    read: { groups: ["manager"], fields: ["status", "total"] },
    write: { groups: ["admin"] }
  })

  await server.add({
    table: "order",
    obj: { _id: "o1", status: "open", total: 100, margin: 30 },
    sessionId: "writer",
    req: { user: { _id: "admin", groups: ["admin"] } }
  })
  await server.update({
    table: "order",
    id: "o1",
    set: { status: "done", margin: 40 },
    sessionId: "writer",
    req: { user: { _id: "admin", groups: ["admin"] } }
  })
  await server.update({
    table: "order",
    id: "o1",
    set: { margin: 50 },
    sessionId: "writer",
    req: { user: { _id: "admin", groups: ["admin"] } }
  })

  const req = { user: { _id: "m1", groups: ["manager"] } }

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
      userId: "admin"
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
      userId: "admin"
    }
  ])
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

test("sync does not load changed documents when permission rules have no if", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1"
  })
  await allowTable(mongo, "order", "manager")

  await server.add({
    table: "order",
    obj: { _id: "o1", status: "open", total: 100 },
    sessionId: "writer",
    req: { user: { _id: "m1", groups: ["manager"] } }
  })

  mongo.collection("order").findOneCalls = 0

  const sync = await server.sync({
    from: "2026-05-21T10:00:00.000Z",
    sessionId: "reader",
    req: { user: { _id: "m2", groups: ["manager"] } }
  })

  assert.deepEqual(sync.changes.map((change) => change.id), ["o1"])
  assert.equal(mongo.collection("order").findOneCalls, 0)
})

test("code access can lazily load a sync document", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: () => "2026-05-21T10:00:01.000Z",
    createLogId: () => "log1",
    access: {
      order: {
        read: async ({ loadDoc }) => {
          const doc = await loadDoc()
          return doc?.status === "open"
        }
      }
    }
  })
  await mongo.collection("_permission").insertOne({
    _id: "perm_order_admin_write",
    table: "order",
    write: { groups: ["admin"] }
  })

  await server.add({
    table: "order",
    obj: { _id: "o1", status: "open" },
    sessionId: "writer",
    req: { user: { _id: "admin", groups: ["admin"] } }
  })

  mongo.collection("order").findOneCalls = 0

  const sync = await server.sync({
    from: "2026-05-21T10:00:00.000Z",
    sessionId: "reader",
    req: { user: { _id: "m1", groups: ["manager"] } }
  })

  assert.deepEqual(sync.changes.map((change) => change.id), ["o1"])
  assert.equal(mongo.collection("order").findOneCalls, 1)
})

test("code access supports direct table and global rules", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order", "product"],
    access: {
      read: async () => true,
      order: {
        write: async () => false
      }
    }
  })

  await mongo.collection("_permission").insertOne({
    _id: "perm_order",
    table: "order",
    write: { groups: ["admin"] }
  })
  await mongo.collection("product").insertOne({
    _id: "p1",
    title: "Box"
  })

  assert.deepEqual(await server.load({
    table: "product",
    id: "p1",
    req: { user: { _id: "guest", groups: [] } }
  }), {
    _id: "p1",
    title: "Box"
  })

  await assert.rejects(
    () => server.update({
      table: "order",
      id: "o1",
      set: { status: "open" },
      req: { user: { _id: "admin", groups: ["admin"] } }
    }),
    /Write denied/
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
        events.push(`global:${ctx.method}`)
        ctx.filter = { ...ctx.filter, status: "open" }
      },
      afterRead: async (ctx) => {
        events.push(`after:${ctx.result.length}`)
      },
      order: {
        beforeRead: async (ctx) => {
          events.push(`table:${ctx.method}`)
          ctx.filter = { ...ctx.filter, ownerId: ctx.user._id }
        }
      }
    },
    access: {
      order: {
        read: async () => true
      }
    }
  })
  await mongo.collection("order").insertOne({ _id: "o1", status: "open", ownerId: "u1" })
  await mongo.collection("order").insertOne({ _id: "o2", status: "closed", ownerId: "u1" })
  await mongo.collection("order").insertOne({ _id: "o3", status: "open", ownerId: "u2" })

  const ids = await server.getIds({
    table: "order",
    filter: {},
    req: { user: { _id: "u1", groups: [] } }
  })

  assert.deepEqual(ids, ["o1"])
  assert.deepEqual(events, ["global:getIds", "table:getIds", "after:1"])
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
        events.push(`global:${ctx.method}`)
        ctx.set.status = String(ctx.set.status).toLowerCase()
      },
      order: {
        beforeWrite: async (ctx) => {
          events.push(`table:${ctx.action}`)
          ctx.set.hook = true
        },
        afterWrite: async (ctx) => {
          events.push(`after:${ctx.change.action}:${ctx.change.id}`)
        }
      }
    },
    access: {
      order: {
        write: async () => true
      }
    }
  })

  await server.update({
    table: "order",
    id: "o1",
    set: { status: "OPEN" },
    req: { user: { _id: "u1", groups: [] } }
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
  assert.deepEqual(events, ["global:update", "table:update", "after:update:o1"])
})

test("error hooks run for failed reads and writes without swallowing errors", async () => {
  const mongo = createMemoryMongo()
  const events = []
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    hooks: {
      errorRead: async (ctx) => events.push(`read:${ctx.method}:${ctx.error.message}`),
      order: {
        errorWrite: async (ctx) => events.push(`write:${ctx.method}:${ctx.error.message}`)
      }
    },
    access: {
      order: {
        read: async () => false,
        write: async () => false
      }
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

  assert.deepEqual(events, ["read:load:Read denied", "write:update:Write denied"])
})

test("write fields reject forbidden update fields", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    now: clock(["2026-05-21T10:00:01.000Z", "2026-05-21T10:00:02.000Z"]),
    createLogId: idSeq()
  })

  await mongo.collection("_permission").insertOne({
    _id: "perm_order_manager",
    table: "order",
    read: { groups: ["manager"] },
    write: { groups: ["manager"], fields: ["status"] }
  })
  await mongo.collection("order").insertOne({
    _id: "o1",
    status: "open",
    margin: 30
  })
  await server.add({
    table: "order",
    obj: { _id: "o2", status: "open" },
    req: { user: { _id: "m1", groups: ["manager"] } }
  })

  await server.update({
    table: "order",
    id: "o1",
    set: { status: "done" },
    req: { user: { _id: "m1", groups: ["manager"] } }
  })

  await assert.rejects(
    () => server.update({
      table: "order",
      id: "o1",
      set: { margin: 40 },
      req: { user: { _id: "m1", groups: ["manager"] } }
    }),
    /Write denied: field margin/
  )
  await assert.rejects(
    () => server.add({
      table: "order",
      obj: { _id: "o3", status: "open", margin: 40 },
      req: { user: { _id: "m1", groups: ["manager"] } }
    }),
    /Write denied: field margin/
  )

  assert.equal((await mongo.collection("order").findOne({ _id: "o1" })).margin, 30)
  assert.equal((await mongo.collection("order").findOne({ _id: "o2" })).status, "open")
  assert.equal(await mongo.collection("order").findOne({ _id: "o3" }), null)
})

test("code access rules decide before _permission table", async () => {
  const mongo = createMemoryMongo()
  const server = createDbStateServer({
    mongo,
    tables: ["order"],
    access: {
      order: {
        write: async () => false
      }
    }
  })

  await mongo.collection("_permission").insertOne({
    _id: "perm_order",
    table: "order",
    write: { groups: ["admin"] }
  })

  await assert.rejects(
    () => server.update({
      table: "order",
      id: "o1",
      set: { status: "open" },
      req: { user: { _id: "admin", groups: ["admin"] } }
    }),
    /Write denied/
  )
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
  await mongo.collection("_permission").insertOne({
    _id: `perm_${table}_${group}`,
    table,
    read: { groups: [group] },
    write: { groups: [group] }
  })
}

function adminReq() {
  return { user: { _id: "u-admin", groups: ["admins"] } }
}

function matches(item, filter = {}) {
  if (filter.$or) {
    const { $or, ...rest } = filter
    return matches(item, rest) && $or.some((part) => matches(item, part))
  }

  return Object.entries(filter).every(([key, expected]) => {
    const value = item[key]
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
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
