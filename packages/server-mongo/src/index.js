import {
  DB_STATE_MESSAGES,
  applyPatch,
  createChange,
  createPrefixedTableName,
  getByPath,
  normalizeServicePrefix,
  normalizeTables
} from "@db-state/core"
import {
  accessFiltersQuery,
  assertAccess,
  assertFieldsAccess,
  changeWritePaths,
  filterChangeFields,
  filterFields,
  isAllowedField,
  projectFields,
  resolveAccess,
  resolveUser,
  userReadPlan
} from "./access.js"
import { createAuth, defaultAuthHash, defaultPassword } from "./auth.js"
import { runErrorHooks, runHooks } from "./hooks.js"
import { createMethodsDirResolver } from "./methods-dir.js"
import { DEFAULT_COUNTER_COLLECTION, nextNumericId, useNumericId } from "./numeric-id.js"
import { createHandlers, handleRpc } from "./rpc.js"
import { createSocketHub } from "./socket.js"

export { accessAllows, matchesAccessFilter } from "./access.js"
export { createAuth, defaultAuthHash, defaultPassword, hashValue, mergeUserAccess } from "./auth.js"
export { createMethodsDirResolver } from "./methods-dir.js"
export { createHandlers, handleRpc } from "./rpc.js"
export { createSocketHub } from "./socket.js"

const MAX_SYNC_WINDOW_MS = 12 * 60 * 60 * 1000
const MAX_SYNC_AGE_MS = 20 * 24 * 60 * 60 * 1000

export function createDbStateServer(options) {
  const config = normalizeOptions(options)
  const auth = createAuth(config)
  // File methods get { db, api } by default; methodsContext adds or overrides.
  // api does not exist yet — the context object is filled in below, the
  // resolver spreads it at call time.
  const fileMethodsContext = config.methodsDir ? { db: config.mongo } : undefined
  const resolveFileMethod = config.methodsDir
    ? createMethodsDirResolver(config.methodsDir, fileMethodsContext)
    : undefined
  let router
  const socket = createSocketHub(config.socket, async (client, message) => {
    for (const module of config.files) {
      if (await module.handleMessage?.(client, message)) return
    }

    if (message.type === DB_STATE_MESSAGES.login) return auth.login(client, message)
    if (message.type === DB_STATE_MESSAGES.auth) return auth.auth(client, message)
    if (message.type === DB_STATE_MESSAGES.logout) return auth.logout(client, message)
    if (message.type === DB_STATE_MESSAGES.rpc) return handleRpc(router, client, message, resolveFileMethod)
  })
  const changesBroadcaster = createChangesBroadcaster(socket, config)

  // Ключ нового документа, когда клиент не прислал свой.
  // По умолчанию uuid; для таблиц из numericIds — номер по порядку от счётчика.
  async function createDocId(table) {
    if (!useNumericId(config.numericIds, table)) return config.createLogId()
    return nextNumericId(config.mongo, config.counterCollection, table)
  }

  // Общий проход записи: подготовка → beforeWrite → access группы → запись →
  // журнал → рассылка → afterWrite. afterWrite запретить уже не может.
  async function runWrite(ctx, { prepare, apply, paths, write }) {
    try {
      assertTable(config, ctx.table)
      ctx.user = await resolveUser(config, { req: ctx.req })
      ctx.actorId = actorId(ctx.user, config)
      ctx.now = config.now()
      await prepare()

      const before = await runHooks(config, "beforeWrite", ctx)
      if (before?.allowed === false) throw denied("Write", ctx, before.reason)
      // Хук мог поправить set/unset/obj — итоговый документ считаем после него.
      apply?.()

      if (before?.allowed !== true) {
        const access = await assertAccess(config, "write", ctx)
        assertFieldsAccess(access, paths(), "Write")
      }

      ctx.change = await write()
      changesBroadcaster.schedule()
      await runHooks(config, "afterWrite", ctx)
      return ctx.result
    } catch (error) {
      ctx.error = error
      await runErrorHooks(config, "errorWrite", ctx)
      throw error
    }
  }

  async function update({ table, id, set, unset, sessionId, req }) {
    const ctx = { req, table, id, method: "update", action: "update", sessionId }

    return runWrite(ctx, {
      prepare: async () => {
        ctx.old = await getDoc(config, table, id)
        ctx.clientSet = stripInfoSet(set)
        ctx.clientUnset = stripInfoUnset(unset)
        ctx.set = {
          ...ctx.clientSet,
          "info.editid": ctx.actorId,
          "info.editdata": ctx.now
        }
        ctx.unset = ctx.clientUnset
      },
      apply: () => {
        ctx.obj = applyPatch({ ...(ctx.old ?? { _id: id }) }, { set: ctx.set, unset: ctx.unset })
      },
      paths: () => changeWritePaths({ set: ctx.clientSet, unset: ctx.clientUnset }),
      write: async () => {
        await config.mongo.collection(table).updateOne(
          { _id: id },
          {
            $set: ctx.set,
            ...(ctx.unset?.length ? { $unset: Object.fromEntries(ctx.unset.map((key) => [key, ""])) } : {})
          },
          { upsert: true }
        )

        const change = await appendLog(config, {
          table,
          id,
          action: "update",
          // info.editid / info.editdata в журнал не пишем: кто и когда —
          // это userId и createdAt самой записи журнала, теми же значениями.
          // В документе info остаётся, там оно читается вместе с записью.
          set: stripInfoSet(ctx.set),
          unset: ctx.unset?.length ? ctx.unset : undefined,
          sessionId,
          userId: ctx.actorId,
          createdAt: ctx.now
        })

        ctx.result = { ok: true, change }
        return change
      }
    })
  }

  async function add({ table, obj, sessionId, req }) {
    const ctx = { req, table, method: "add", action: "insert", sessionId }

    return runWrite(ctx, {
      prepare: async () => {
        ctx.id = obj._id ?? obj.id ?? await createDocId(table)
        // id принимается как источник ключа, но в документ не попадает:
        // ключ документа — только _id.
        const { id, ...clientObj } = stripInfoObject(obj)
        ctx.clientObj = clientObj
        ctx.obj = {
          ...ctx.clientObj,
          _id: ctx.id,
          info: {
            makeid: ctx.actorId,
            makedata: ctx.now
          }
        }
      },
      apply: () => {
        // Хук мог подменить документ целиком — берём его _id, если он задан.
        ctx.id = ctx.obj._id ?? ctx.id
        ctx.obj._id = ctx.id
      },
      paths: () => changeWritePaths({ obj: ctx.clientObj }),
      write: async () => {
        await config.mongo.collection(table).insertOne(ctx.obj)
        const change = await appendLog(config, {
          table,
          id: ctx.id,
          action: "insert",
          obj: ctx.obj,
          sessionId,
          userId: ctx.actorId,
          createdAt: ctx.now
        })

        ctx.result = { ok: true, id: ctx.id, change }
        return change
      }
    })
  }

  async function remove({ table, id, sessionId, req }) {
    const ctx = { req, table, id, method: "remove", action: "delete", sessionId }

    return runWrite(ctx, {
      prepare: async () => {
        ctx.old = await getDoc(config, table, id)
        ctx.obj = ctx.old
      },
      paths: () => [],
      write: async () => {
        await config.mongo.collection(table).deleteOne({ _id: id })
        const change = await appendLog(config, {
          table,
          id,
          action: "delete",
          old: ctx.old,
          sessionId,
          userId: ctx.actorId
        })

        ctx.result = { ok: true, change }
        return change
      }
    })
  }

  async function load({ table, id, req }) {
    const ctx = { req, table, id, method: "load" }

    return runRead(ctx, async (plan) => {
      // Право и поля — в самом запросе: фильтр проверяет Mongo,
      // projection отдаёт только разрешённые поля.
      if (plan.mode === "none") throw denied("Read", ctx)
      const query = plan.mode === "filter" ? { $and: [{ _id: id }, plan.query] } : { _id: id }
      const options = plan.fields ? { projection: fieldsProjection(plan.fields) } : undefined

      ctx.obj = await config.mongo.collection(table).findOne(query, options)
      if (plan.mode === "filter" && !ctx.obj) throw denied("Read", ctx)
      // Повторная проекция — no-op для реальной Mongo, гарантия для duck-typed баз.
      return projectFields(ctx.obj, plan.fields)
    })
  }

  async function getIds({ table, filter = {}, sort, skip = 0, limit = 0, req }) {
    const ctx = { req, table, method: "getIds", filter, sort, skip, limit }

    return runRead(ctx, async (plan) => {
      if (plan.mode === "none") {
        ctx.rows = []
        return []
      }

      // Право уже в запросе — построчные проверки не нужны, тянем только _id.
      let cursor = config.mongo
        .collection(table)
        .find(readPlanQuery(ctx.filter, plan), { projection: { _id: 1 } })
      if (ctx.sort) cursor = cursor.sort(ctx.sort)
      if (ctx.skip) cursor = cursor.skip(ctx.skip)
      if (ctx.limit) cursor = cursor.limit(ctx.limit)

      ctx.rows = await cursor.toArray()
      return ctx.rows.map((row) => row._id ?? row.id)
    })
  }

  // Общий проход чтения: beforeRead → access группы → запрос → afterRead.
  async function runRead(ctx, read) {
    try {
      assertTable(config, ctx.table)
      ctx.user = await resolveUser(config, { req: ctx.req })

      const before = await runHooks(config, "beforeRead", ctx)
      if (before?.allowed === false) throw denied("Read", ctx, before.reason)

      // Хук разрешил явно — право группы не спрашиваем, но поля из ctx.fields
      // всё равно применяем.
      const plan = before?.allowed === true
        ? { mode: "all", fields: Array.isArray(ctx.fields) ? ctx.fields : undefined }
        : await userReadPlan(config, ctx)

      // Фильтровать и сортировать можно только по видимым полям: иначе
      // скрытое значение восстанавливается по наличию или порядку строк.
      // _id всегда входит в проекцию и поэтому остаётся доступным.
      if (plan.fields) {
        const queryPaths = [
          ...filterFields(ctx.filter),
          ...Object.keys(ctx.sort ?? {})
        ]
        assertFieldsAccess({ fields: ["_id", ...plan.fields] }, queryPaths, "Read")
      }

      ctx.result = await read(plan)
      if (plan.fields) markFieldsFiltered(ctx.req)

      const after = await runHooks(config, "afterRead", ctx)
      if (after?.allowed === false) throw denied("Read", ctx, after.reason)
      return ctx.result
    } catch (error) {
      ctx.error = error
      await runErrorHooks(config, "errorRead", ctx)
      throw error
    }
  }

  async function getUnique({ table, field, filter = {}, req }) {
    const ctx = { req, table, method: "getUnique", field, filter }

    return runRead(ctx, async (plan) => {
      if (plan.mode === "none") return []
      // Поле вне разрешённого списка — значений не отдаём.
      if (plan.fields && !isAllowedField(field, plan.fields)) return []

      // Право — в условии запроса, из полей просим только нужное.
      const rows = await config.mongo
        .collection(table)
        .find(readPlanQuery(ctx.filter, plan), { projection: { _id: 1, [field]: 1 } })
        .toArray()

      const values = rows.map((row) => getByPath(row, field))
      return [...new Set(values.filter((value) => value != null))]
    })
  }

  async function count({ table, filter = {}, req }) {
    const ctx = { req, table, method: "count", filter }

    return runRead(ctx, async (plan) => {
      if (plan.mode === "none") return 0

      // Право уже в запросе: настоящий countDocuments без выгрузки строк.
      const collection = config.mongo.collection(table)
      const query = readPlanQuery(ctx.filter, plan)
      return typeof collection.countDocuments === "function"
        ? await collection.countDocuments(query)
        : (await collection.find(query).toArray()).length
    })
  }

  async function sync({ from, sessionId, req }) {
    const readCtx = { req, method: "sync", from, sessionId }

    try {
      readCtx.user = await resolveUser(config, { req })
      const before = await runHooks(config, "beforeRead", readCtx)
      if (before?.allowed === false) throw denied("Read", readCtx, before.reason)
      const window = createSyncWindow(readCtx.from, config.now())
      readCtx.from = window.from
      readCtx.to = window.to

      if (window.reset) {
        readCtx.result = { to: readCtx.to, changes: [], reset: true }
        const afterReset = await runHooks(config, "afterRead", readCtx)
        if (afterReset?.allowed === false) throw denied("Read", readCtx, afterReset.reason)
        return readCtx.result
      }

      const changes = await config.mongo
        .collection(config.logCollection)
        .find({
          createdAt: { $gt: readCtx.from, $lte: readCtx.to },
          ...(readCtx.sessionId ? { sessionId: { $ne: readCtx.sessionId } } : {})
        })
        .sort({ createdAt: 1, _id: 1 })
        .toArray()

      const allowed = []
      for (const row of changes) {
        // Normalize both new rows and pre-0.2 rows at the public boundary:
        // legacy logId/unknown fields are dropped and nullish payload fields
        // stay absent. Existing rows already have the same Mongo _id.
        const change = createChange({ ...row, _id: row._id ?? row.logId })
        let didLoadDoc = change.action === "delete"
        const ctx = {
          req,
          user: readCtx.user,
          method: "sync",
          table: change.table,
          id: change.id,
          old: change.old,
          change,
          obj: change.action === "delete" ? change.old : undefined,
          loadDoc: async () => {
            if (!didLoadDoc) {
              ctx.obj = await getDoc(config, change.table, change.id)
              didLoadDoc = true
            }

            return ctx.obj
          },
          // Фильтр права проверяет база одним запросом: findOne({_id} + фильтр).
          matchAccessFilters: change.action === "delete" ? undefined : async (filters, user) =>
            Boolean(await config.mongo.collection(change.table).findOne({
              $and: [{ _id: change.id }, accessFiltersQuery(filters, user)]
            }))
        }

        // Хук разрешил sync целиком — права по таблицам не спрашиваем.
        const access = before?.allowed === true
          ? { allowed: true, fields: Array.isArray(readCtx.fields) ? readCtx.fields : undefined }
          : await resolveAccess(config, "read", ctx)
        if (!access.allowed) continue

        if (access.fields) markFieldsFiltered(req)
        const filtered = filterChangeFields(change, access.fields)
        if (filtered) allowed.push(filtered)
      }

      readCtx.result = {
        to: readCtx.to,
        changes: allowed,
        ...(window.hasMore ? { hasMore: true } : {})
      }
      const after = await runHooks(config, "afterRead", readCtx)
      if (after?.allowed === false) throw denied("Read", readCtx, after.reason)
      return readCtx.result
    } catch (error) {
      readCtx.error = error
      await runErrorHooks(config, "errorRead", readCtx)
      throw error
    }
  }

  router = createHandlers({ add, count, getIds, getUnique, load, remove, sync, update })
  for (const [name, handler] of Object.entries(config.methods)) {
    if (router[name]) throw new Error(`db-state RPC method already exists: ${name}`)
    router[name] = handler
  }

  const api = { add, count, getIds, getUnique, load, remove, socket, sync, update }
  if (fileMethodsContext) Object.assign(fileMethodsContext, { api }, config.methodsContext)
  for (const module of config.files) {
    module.bind?.({ api, config, mongo: config.mongo, socket })
    socket.onRawMessage((client, raw) => module.handleRawMessage?.(client, raw))
    socket.onClientClose((client) => module.handleClose?.(client))
  }

  return api
}

function createSyncWindow(from, now) {
  const fromTime = Date.parse(from)
  const nowTime = Date.parse(now)
  if (!Number.isFinite(fromTime) || !Number.isFinite(nowTime)) {
    throw new Error("Invalid sync timestamp")
  }

  const normalizedFrom = new Date(fromTime).toISOString()
  const normalizedNow = new Date(nowTime).toISOString()
  if (nowTime - fromTime > MAX_SYNC_AGE_MS) {
    return { from: normalizedFrom, to: normalizedNow, reset: true }
  }

  const windowEnd = Math.min(nowTime, fromTime + MAX_SYNC_WINDOW_MS)
  return {
    from: normalizedFrom,
    to: windowEnd === nowTime ? normalizedNow : new Date(windowEnd).toISOString(),
    hasMore: windowEnd < nowTime
  }
}

async function appendLog(config, change) {
  const item = createChange({
    ...change,
    _id: config.createLogId(),
    createdAt: change.createdAt ?? config.now()
  })

  await config.mongo.collection(config.logCollection).insertOne(item)
  return item
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

function normalizeOptions(options) {
  const servicePrefix = normalizeServicePrefix(options)
  const userTable = options.userTable ?? createPrefixedTableName(servicePrefix, "user", "_user")
  const groupTable = options.groupTable ?? createPrefixedTableName(servicePrefix, "group", "_group")
  const logCollection = options.logCollection ?? createPrefixedTableName(servicePrefix, "log", "log")
  const files = normalizeModules(options.files, servicePrefix)
  const fileTables = files.flatMap((module) => module.tables ?? [module.table]).filter(Boolean)
  const hooks = chainHooks([...files.map((module) => module.hooks ?? {}), options.hooks ?? {}])
  const methods = mergeConfigs(options.methods ?? {}, ...files.map((module) => module.methods ?? {}))

  return {
    authRateLimit: undefined,
    counterCollection: createPrefixedTableName(servicePrefix, "counter", DEFAULT_COUNTER_COLLECTION),
    createAuthHash: defaultAuthHash,
    createLogId: defaultId,
    numericIds: false,
    changesBroadcastDelay: 3000,
    changesBroadcastRate: 100,
    getUser: async ({ req, client }) => req?.user ?? req?.client?.user ?? client?.user ?? makeUser(req?.client ?? req ?? client),
    hooks: {},
    now: () => new Date().toISOString(),
    normalizeAuthLogin: defaultNormalizeAuthLogin,
    onAuthWarning: undefined,
    password: defaultPassword,
    systemUserId: "system",
    ...options,
    authLoginFields: normalizeAuthLoginFields(options.authLoginFields),
    files,
    groupTable,
    hooks,
    methods,
    logCollection,
    servicePrefix,
    tables: new Set(normalizeTables([...(options.tables ?? []), ...fileTables])),
    userTable
  }
}

function normalizeModules(input, servicePrefix) {
  if (!input) return []
  const modules = Array.isArray(input) ? input : [input]
  return modules.map((module) => module.withServicePrefix?.(servicePrefix) ?? module)
}


function mergeConfigs(...items) {
  return Object.assign({}, ...items)
}

// Хуки подключённых модулей и приложения не затирают друг друга, а идут
// цепочкой: сначала модули, потом хук приложения. Первый явный ответ
// (true/false) останавливает цепочку — остальные уже не вызываются.
function chainHooks(sources) {
  const names = new Set(sources.flatMap((source) => Object.keys(source ?? {})))
  const out = {}

  for (const name of names) {
    const chain = sources.map((source) => source?.[name]).filter((hook) => typeof hook === "function")
    if (chain.length === 0) continue
    if (chain.length === 1) {
      out[name] = chain[0]
      continue
    }

    out[name] = async (ctx) => {
      for (const hook of chain) {
        const decision = await hook(ctx)
        if (decision !== undefined && decision !== null) return decision
      }
      return undefined
    }
  }

  return out
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

// Mongo-projection из белого списка полей (плюс всегда _id).
function fieldsProjection(fields) {
  const projection = { _id: 1 }
  for (const field of fields) projection[field] = 1
  return projection
}

// Итоговый Mongo-запрос списка: фильтр клиента + условие права.
function readPlanQuery(filter, plan) {
  if (!plan || plan.mode !== "filter") return filter
  if (!filter || Object.keys(filter).length === 0) return plan.query
  return { $and: [filter, plan.query] }
}

// Причина от хука уходит клиенту как есть; без неё — общее сообщение.
function denied(label, ctx, reason) {
  return new Error(reason ?? `${label} denied: ${ctx.table ?? ctx.method}`)
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
