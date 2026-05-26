import { DB_STATE_MESSAGES, applyPatch, createChange, getByPath, normalizeTables } from "@db-state/core"
import {
  assertAccess,
  assertFieldsAccess,
  changeWritePaths,
  filterChangeFields,
  filterReadable,
  hasHiddenChangeFields,
  hasHiddenFields,
  isAllowedField,
  projectFields,
  resolveAccess,
  resolveUser
} from "./access.js"
import { createAuth, defaultAuthHash, defaultPassword } from "./auth.js"
import { runErrorHooks, runHooks } from "./hooks.js"
import { createHandlers, handleRpc } from "./rpc.js"
import { createSocketHub } from "./socket.js"

export { createAuth, defaultAuthHash, defaultPassword, hashValue } from "./auth.js"
export { createHandlers, handleRpc } from "./rpc.js"
export { createSocketHub } from "./socket.js"

export function createDbStateServer(options) {
  const config = normalizeOptions(options)
  const auth = createAuth(config)
  let router
  const socket = createSocketHub(config.socket, async (client, message) => {
    for (const module of config.files) {
      if (await module.handleMessage?.(client, message)) return
    }

    if (message.type === DB_STATE_MESSAGES.login) return auth.login(client, message)
    if (message.type === DB_STATE_MESSAGES.auth) return auth.auth(client, message)
    if (message.type === DB_STATE_MESSAGES.logout) return auth.logout(client, message)
    if (message.type === DB_STATE_MESSAGES.rpc) return handleRpc(router, client, message)
  })
  const changesBroadcaster = createChangesBroadcaster(socket, config)

  async function update({ table, id, set, unset, sessionId, req }) {
    assertTable(config, table)
    const ctx = { req, table, id, method: "update", action: "update", sessionId }

    try {
      ctx.user = await resolveUser(config, { req })
      ctx.actorId = actorId(ctx.user, config)
      ctx.now = config.now()
      ctx.old = await getDoc(config, table, id)
      ctx.clientSet = stripInfoSet(set)
      ctx.clientUnset = stripInfoUnset(unset)
      ctx.set = {
        ...ctx.clientSet,
        "info.editid": ctx.actorId,
        "info.editdata": ctx.now
      }
      ctx.unset = ctx.clientUnset
      await runHooks(config, table, "beforeWrite", ctx)
      ctx.obj = applyPatch({ ...(ctx.old ?? { _id: id }) }, { set: ctx.set, unset: ctx.unset })
      const access = await assertAccess(config, "write", ctx)
      assertFieldsAccess(access, changeWritePaths({ set: ctx.clientSet, unset: ctx.clientUnset }), "Write")

      await config.mongo.collection(table).updateOne(
        { _id: id },
        {
          $set: ctx.set,
          ...(ctx.unset?.length ? { $unset: Object.fromEntries(ctx.unset.map((key) => [key, ""])) } : {})
        },
        { upsert: true }
      )

      ctx.change = await appendLog(config, {
        table,
        id,
        action: "update",
        set: ctx.set,
        unset: ctx.unset?.length ? ctx.unset : undefined,
        sessionId,
        userId: ctx.actorId,
        createdAt: ctx.now
      })

      changesBroadcaster.schedule()
      ctx.result = { ok: true, change: ctx.change }
      await runHooks(config, table, "afterWrite", ctx)
      return ctx.result
    } catch (error) {
      ctx.error = error
      await runErrorHooks(config, table, "errorWrite", ctx)
      throw error
    }
  }

  async function add({ table, obj, sessionId, req }) {
    assertTable(config, table)
    const ctx = { req, table, method: "add", action: "insert", sessionId }

    try {
      ctx.user = await resolveUser(config, { req })
      ctx.actorId = actorId(ctx.user, config)
      ctx.now = config.now()
      ctx.id = obj._id ?? obj.id ?? config.createLogId()
      ctx.clientObj = stripInfoObject(obj)
      ctx.obj = {
        ...ctx.clientObj,
        _id: ctx.id,
        info: {
          makeid: ctx.actorId,
          makedata: ctx.now
        }
      }
      await runHooks(config, table, "beforeWrite", ctx)
      ctx.id = ctx.id ?? ctx.obj._id ?? ctx.obj.id
      ctx.obj._id = ctx.id
      const access = await assertAccess(config, "write", ctx)
      assertFieldsAccess(access, changeWritePaths({ obj: ctx.clientObj }), "Write")

      await config.mongo.collection(table).insertOne(ctx.obj)
      ctx.change = await appendLog(config, {
        table,
        id: ctx.id,
        action: "insert",
        obj: ctx.obj,
        sessionId,
        userId: ctx.actorId,
        createdAt: ctx.now
      })

      changesBroadcaster.schedule()
      ctx.result = { ok: true, id: ctx.id, change: ctx.change }
      await runHooks(config, table, "afterWrite", ctx)
      return ctx.result
    } catch (error) {
      ctx.error = error
      await runErrorHooks(config, table, "errorWrite", ctx)
      throw error
    }
  }

  async function remove({ table, id, sessionId, req }) {
    assertTable(config, table)
    const ctx = { req, table, id, method: "remove", action: "delete", sessionId }

    try {
      ctx.user = await resolveUser(config, { req })
      ctx.actorId = actorId(ctx.user, config)
      ctx.old = await getDoc(config, table, id)
      ctx.obj = ctx.old
      await runHooks(config, table, "beforeWrite", ctx)
      await assertAccess(config, "write", ctx)

      await config.mongo.collection(table).deleteOne({ _id: id })
      ctx.change = await appendLog(config, {
        table,
        id,
        action: "delete",
        old: ctx.old,
        sessionId,
        userId: ctx.actorId
      })

      changesBroadcaster.schedule()
      ctx.result = { ok: true, change: ctx.change }
      await runHooks(config, table, "afterWrite", ctx)
      return ctx.result
    } catch (error) {
      ctx.error = error
      await runErrorHooks(config, table, "errorWrite", ctx)
      throw error
    }
  }

  async function load({ table, id, req }) {
    assertTable(config, table)
    const ctx = { req, table, id, method: "load" }

    try {
      ctx.user = await resolveUser(config, { req })
      await runHooks(config, table, "beforeRead", ctx)
      ctx.obj = await getDoc(config, table, id)
      const access = await assertAccess(config, "read", ctx)
      if (hasHiddenFields(ctx.obj, access.fields)) markFieldsFiltered(req)
      ctx.result = projectFields(ctx.obj, access.fields)
      await runHooks(config, table, "afterRead", ctx)
      return ctx.result
    } catch (error) {
      ctx.error = error
      await runErrorHooks(config, table, "errorRead", ctx)
      throw error
    }
  }

  async function getIds({ table, filter = {}, sort, skip = 0, limit = 0, req }) {
    assertTable(config, table)
    const ctx = { req, table, method: "getIds", filter, sort, skip, limit }

    try {
      ctx.user = await resolveUser(config, { req })
      await runHooks(config, table, "beforeRead", ctx)
      let cursor = config.mongo.collection(table).find(ctx.filter)
      if (ctx.sort) cursor = cursor.sort(ctx.sort)
      if (ctx.skip) cursor = cursor.skip(ctx.skip)
      if (ctx.limit) cursor = cursor.limit(ctx.limit)
      const rawRows = await cursor.toArray()
      ctx.rows = await filterReadable(config, req, table, rawRows)
      markAccessFiltered(req, rawRows.length - ctx.rows.length)
      ctx.result = ctx.rows.map((row) => row._id ?? row.id)
      await runHooks(config, table, "afterRead", ctx)
      return ctx.result
    } catch (error) {
      ctx.error = error
      await runErrorHooks(config, table, "errorRead", ctx)
      throw error
    }
  }

  async function getUnique({ table, field, filter = {}, req }) {
    assertTable(config, table)
    const ctx = { req, table, method: "getUnique", field, filter }

    try {
      ctx.user = await resolveUser(config, { req })
      await runHooks(config, table, "beforeRead", ctx)
      const values = []
      let denied = 0
      for (const row of await config.mongo.collection(table).find(ctx.filter).toArray()) {
        const access = await resolveAccess(config, "read", { req, table, id: row._id ?? row.id, obj: row })
        if (!access.allowed) {
          denied += 1
          continue
        }
        if (access.fields && !isAllowedField(field, access.fields)) markFieldsFiltered(req)
        values.push(getByPath(projectFields(row, access.fields), field))
      }
      markAccessFiltered(req, denied)
      ctx.result = [...new Set(values.filter((value) => value != null))]
      await runHooks(config, table, "afterRead", ctx)
      return ctx.result
    } catch (error) {
      ctx.error = error
      await runErrorHooks(config, table, "errorRead", ctx)
      throw error
    }
  }

  async function count({ table, filter = {}, req }) {
    assertTable(config, table)
    const ctx = { req, table, method: "count", filter }

    try {
      ctx.user = await resolveUser(config, { req })
      await runHooks(config, table, "beforeRead", ctx)
      const rawRows = await config.mongo.collection(table).find(ctx.filter).toArray()
      ctx.rows = await filterReadable(config, req, table, rawRows)
      markAccessFiltered(req, rawRows.length - ctx.rows.length)
      ctx.result = ctx.rows.length
      await runHooks(config, table, "afterRead", ctx)
      return ctx.result
    } catch (error) {
      ctx.error = error
      await runErrorHooks(config, table, "errorRead", ctx)
      throw error
    }
  }

  async function sync({ from, sessionId, req, limit = config.syncLimit }) {
    const readCtx = { req, method: "sync", from, sessionId, limit }

    try {
      readCtx.user = await resolveUser(config, { req })
      await runHooks(config, undefined, "beforeRead", readCtx)
      readCtx.to = config.now()
      const permissionRulesByTable = new Map()
      const changes = await config.mongo
        .collection(config.logCollection)
        .find({
          createdAt: { $gt: readCtx.from, $lte: readCtx.to },
          ...(readCtx.sessionId ? { sessionId: { $ne: readCtx.sessionId } } : {})
        })
        .sort({ createdAt: 1, logId: 1 })
        .limit(readCtx.limit)
        .toArray()

      const allowed = []
      let denied = 0
      for (const row of changes) {
        const change = publicChange(row)
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
        if (!access.allowed) {
          denied += 1
          continue
        }

        if (hasHiddenChangeFields(change, access.fields)) markFieldsFiltered(req)
        const filtered = filterChangeFields(change, access.fields)
        if (filtered) allowed.push(filtered)
      }

      markAccessFiltered(req, denied)
      readCtx.result = { to: readCtx.to, changes: allowed }
      await runHooks(config, undefined, "afterRead", readCtx)
      return readCtx.result
    } catch (error) {
      readCtx.error = error
      await runErrorHooks(config, undefined, "errorRead", readCtx)
      throw error
    }
  }

  router = createHandlers({ add, count, getIds, getUnique, load, remove, sync, update })

  const api = { add, count, getIds, getUnique, load, remove, socket, sync, update }
  for (const module of config.files) {
    module.bind?.({ api, config, mongo: config.mongo, socket })
    socket.onRawMessage((client, raw) => module.handleRawMessage?.(client, raw))
    socket.onClientClose((client) => module.handleClose?.(client))
  }

  return api
}

async function appendLog(config, change) {
  const item = createChange({
    ...change,
    logId: config.createLogId(),
    createdAt: change.createdAt ?? config.now()
  })

  await config.mongo.collection(config.logCollection).insertOne({ _id: item.logId, ...item })
  return item
}

function publicChange(change) {
  const { _id, ...rest } = change
  return rest
}

function getDoc(config, table, id) {
  return config.mongo.collection(table).findOne({ _id: id })
}

function stripInfoObject(obj = {}) {
  const { info, ...rest } = obj
  return rest
}

function stripInfoSet(set) {
  if (!set) return undefined

  const entries = Object.entries(set).filter(([path]) => !isInfoPath(path))
  return entries.length ? Object.fromEntries(entries) : undefined
}

function stripInfoUnset(unset) {
  return (unset ?? []).filter((path) => !isInfoPath(path))
}

function isInfoPath(path) {
  return path === "info" || path.startsWith("info.")
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
  const files = normalizeModules(options.files)
  const fileTables = files.flatMap((module) => module.tables ?? [module.table]).filter(Boolean)
  const access = mergeConfigs(options.access ?? {}, ...files.map((module) => module.access ?? {}))
  const hooks = mergeConfigs(options.hooks ?? {}, ...files.map((module) => module.hooks ?? {}))

  return {
    access: {},
    authRateLimit: undefined,
    createAuthHash: defaultAuthHash,
    createLogId: defaultId,
    changesBroadcastDelay: 3000,
    changesBroadcastRate: 100,
    getUser: async ({ req, client }) => req?.user ?? req?.client?.user ?? client?.user ?? makeUser(req?.client ?? req ?? client),
    hooks: {},
    logCollection: "log",
    now: () => new Date().toISOString(),
    normalizeAuthLogin: defaultNormalizeAuthLogin,
    onAuthWarning: undefined,
    password: defaultPassword,
    permissionTable: "_permission",
    systemUserId: "system",
    syncLimit: 1000,
    userTable: "_user",
    ...options,
    access,
    authLoginFields: normalizeAuthLoginFields(options.authLoginFields),
    files,
    hooks,
    tables: new Set(normalizeTables([...(options.tables ?? []), ...fileTables]))
  }
}

function normalizeModules(input) {
  if (!input) return []
  return Array.isArray(input) ? input : [input]
}

function mergeConfigs(...items) {
  return Object.assign({}, ...items)
}

function normalizeAuthLoginFields(fields) {
  const normalized = [...new Set((fields ?? ["login"]).filter(Boolean))]
  return normalized.length > 0 ? normalized : ["login"]
}

function defaultNormalizeAuthLogin(value) {
  return String(value ?? "").trim()
}

function actorId(user, config) {
  return user?._id ?? config.systemUserId
}

function markAccessFiltered(req, denied) {
  if (!req || denied <= 0) return
  req.dbStateMeta ??= {}
  req.dbStateMeta.accessFiltered = true
  req.dbStateMeta.denied = (req.dbStateMeta.denied ?? 0) + denied
}

function markFieldsFiltered(req) {
  if (!req) return
  req.dbStateMeta ??= {}
  req.dbStateMeta.fieldsFiltered = true
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

function createChangesBroadcaster(socket, config) {
  let timer
  let signal

  return {
    schedule() {
      if (signal) signal.cancelled = true
      clearTimeout(timer)

      signal = { cancelled: false }
      timer = setTimeout(() => {
        const current = signal
        Promise.resolve(socket.broadcast(
          { type: DB_STATE_MESSAGES.changesAvailable },
          { rate: config.changesBroadcastRate, signal: current }
        )).catch(() => {}).finally(() => {
          if (signal === current) signal = undefined
        })
      }, Math.max(0, config.changesBroadcastDelay))
    }
  }
}
