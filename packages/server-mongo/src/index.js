import { DB_STATE_EVENTS, applyPatch, createChange, getByPath, normalizeTables } from "@db-state/core"
import {
  assertAccess,
  assertFieldsAccess,
  changeWritePaths,
  filterChangeFields,
  filterReadable,
  projectFields,
  resolveAccess,
  resolveUser
} from "./access.js"
import { createAuth, defaultAuthHash, defaultPassword } from "./auth.js"
import { createHandlers, handleRpc } from "./rpc.js"
import { createSocketHub } from "./socket.js"

export function createDbStateServer(options) {
  const config = normalizeOptions(options)
  const auth = createAuth(config)
  let router
  const socket = createSocketHub(config.socket, async (client, message) => {
    if (message.type === "dbstate:login") return auth.login(client, message)
    if (message.type === "dbstate:auth") return auth.auth(client, message)
    if (message.type === "dbstate:logout") return auth.logout(client, message)
    if (message.type === "dbstate:rpc") return handleRpc(router, client, message)
  })

  async function update({ table, id, set, unset, sessionId, req }) {
    assertTable(config, table)
    const user = await resolveUser(config, { req })
    const old = await getDoc(config, table, id)
    const obj = applyPatch({ ...(old ?? { _id: id }) }, { set, unset })
    const access = await assertAccess(config, "write", { req, table, id, obj, old, set, unset, action: "update" })
    assertFieldsAccess(access, changeWritePaths({ set, unset }), "Write")

    await config.mongo.collection(table).updateOne(
      { _id: id },
      {
        ...(set ? { $set: set } : {}),
        ...(unset ? { $unset: Object.fromEntries(unset.map((key) => [key, ""])) } : {})
      },
      { upsert: true }
    )

    const change = await appendLog(config, {
      table,
      id,
      action: "update",
      set,
      unset,
      sessionId,
      userId: user?._id
    })

    broadcastChange(socket, change, sessionId)
    return { ok: true, change }
  }

  async function add({ table, obj, sessionId, req }) {
    assertTable(config, table)
    const user = await resolveUser(config, { req })
    const id = obj._id ?? obj.id ?? config.createLogId()
    const document = { ...obj, _id: id }
    const access = await assertAccess(config, "write", { req, table, id, obj: document, action: "insert" })
    assertFieldsAccess(access, changeWritePaths({ obj: document }), "Write")

    await config.mongo.collection(table).insertOne(document)
    const change = await appendLog(config, {
      table,
      id,
      action: "insert",
      obj: document,
      sessionId,
      userId: user?._id
    })

    broadcastChange(socket, change, sessionId)
    return { ok: true, id, change }
  }

  async function remove({ table, id, sessionId, req }) {
    assertTable(config, table)
    const user = await resolveUser(config, { req })
    const old = await getDoc(config, table, id)
    await assertAccess(config, "write", { req, table, id, obj: old, old, action: "delete" })

    await config.mongo.collection(table).deleteOne({ _id: id })
    const change = await appendLog(config, {
      table,
      id,
      action: "delete",
      old,
      sessionId,
      userId: user?._id
    })

    broadcastChange(socket, change, sessionId)
    return { ok: true, change }
  }

  async function load({ table, id, req }) {
    assertTable(config, table)
    const obj = await getDoc(config, table, id)
    const access = await assertAccess(config, "read", { req, table, id, obj })
    return projectFields(obj, access.fields)
  }

  async function getIds({ table, filter = {}, sort, skip = 0, limit = 0, req }) {
    assertTable(config, table)
    let cursor = config.mongo.collection(table).find(filter)
    if (sort) cursor = cursor.sort(sort)
    if (skip) cursor = cursor.skip(skip)
    if (limit) cursor = cursor.limit(limit)
    return (await filterReadable(config, req, table, await cursor.toArray())).map((row) => row._id ?? row.id)
  }

  async function getUnique({ table, field, filter = {}, req }) {
    assertTable(config, table)
    const values = []
    for (const row of await config.mongo.collection(table).find(filter).toArray()) {
      const access = await resolveAccess(config, "read", { req, table, id: row._id ?? row.id, obj: row })
      if (!access.allowed) continue
      values.push(getByPath(projectFields(row, access.fields), field))
    }
    return [...new Set(values.filter((value) => value != null))]
  }

  async function count({ table, filter = {}, req }) {
    assertTable(config, table)
    return (await filterReadable(config, req, table, await config.mongo.collection(table).find(filter).toArray())).length
  }

  async function sync({ from, sessionId, req, limit = config.syncLimit }) {
    const to = config.now()
    const permissionRulesByTable = new Map()
    const changes = await config.mongo
      .collection(config.logCollection)
      .find({
        createdAt: { $gt: from, $lte: to },
        ...(sessionId ? { sessionId: { $ne: sessionId } } : {})
      })
      .sort({ createdAt: 1, logId: 1 })
      .limit(limit)
      .toArray()

    const allowed = []
    for (const change of changes) {
      const permissionRules = await getPermissionRules(config, permissionRulesByTable, change.table)
      let didLoadDoc = change.action === "delete"
      const ctx = {
        req,
        table: change.table,
        id: change.id,
        old: change.old,
        change,
        permissionRules,
        obj: change.action === "delete" ? change.old : undefined,
        loadDoc: async () => {
          if (!didLoadDoc) {
            ctx.obj = await getDoc(config, change.table, change.id)
            didLoadDoc = true
          }

          return ctx.obj
        }
      }

      if (change.action !== "delete" && permissionRules.some((rule) => rule.if)) {
        await ctx.loadDoc()
      }

      const access = await resolveAccess(config, "read", ctx)
      const filtered = access.allowed ? filterChangeFields(change, access.fields) : undefined
      if (filtered) allowed.push(filtered)
    }

    return { to, changes: allowed }
  }

  router = createHandlers({ add, count, getIds, getUnique, load, remove, sync, update })

  return { add, count, getIds, getUnique, load, remove, socket, sync, update }
}

function broadcastChange(socket, change, sessionId) {
  socket.broadcast(
    {
      type: DB_STATE_EVENTS.changesAvailable,
      table: change.table,
      id: change.id,
      to: change.createdAt
    },
    { excludeSessionId: sessionId }
  )
}

async function appendLog(config, change) {
  const item = createChange({
    ...change,
    logId: config.createLogId(),
    createdAt: config.now()
  })

  await config.mongo.collection(config.logCollection).insertOne(item)
  return item
}

function getDoc(config, table, id) {
  return config.mongo.collection(table).findOne({ _id: id })
}

async function getPermissionRules(config, cache, table) {
  if (!cache.has(table)) {
    cache.set(table, await config.mongo
      .collection(config.permissionTable)
      .find({ table })
      .sort({ priority: -1 })
      .toArray())
  }

  return cache.get(table)
}

function normalizeOptions(options) {
  return {
    access: {},
    createAuthHash: defaultAuthHash,
    createLogId: defaultId,
    getUser: async ({ req, client }) => req?.user ?? req?.client?.user ?? client?.user ?? makeUser(req?.client ?? req ?? client),
    logCollection: "log",
    now: () => new Date().toISOString(),
    password: defaultPassword,
    permissionTable: "_permission",
    syncLimit: 1000,
    userTable: "_user",
    ...options,
    tables: new Set(normalizeTables(options.tables))
  }
}

function assertTable(config, table) {
  if (!config.tables.has(table)) {
    throw new Error(`Unknown db-state table: ${table}`)
  }
}

function makeUser(source = {}) {
  const id = source.userId ?? source._id
  return id ? { _id: id, groups: source.groups ?? [] } : undefined
}

function defaultId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`
}
