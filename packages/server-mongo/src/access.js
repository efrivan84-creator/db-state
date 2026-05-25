import { getByPath, setByPath } from "@db-state/core"

export async function assertAccess(config, action, ctx) {
  const access = await resolveAccess(config, action, ctx)
  if (!access.allowed) {
    throw new Error(`${action === "read" ? "Read" : "Write"} denied`)
  }

  return access
}

export async function canAccess(config, action, ctx) {
  return (await resolveAccess(config, action, ctx)).allowed
}

export async function resolveAccess(config, action, ctx) {
  const user = await resolveUser(config, ctx)
  const fullCtx = { ...ctx, user, docId: ctx.id }

  const codeDecision = await codeAccessDecision(config.access, action, fullCtx)
  if (codeDecision !== undefined && codeDecision !== null) return normalizeDecision(codeDecision)

  const permissionDecision = await permissionDecisionFromDb(config, action, fullCtx)
  if (permissionDecision !== undefined && permissionDecision !== null) return permissionDecision

  return { allowed: false }
}

export async function filterReadable(config, req, table, rows) {
  const out = []
  for (const obj of rows) {
    if (await canAccess(config, "read", { req, table, id: obj._id ?? obj.id, obj })) {
      out.push(obj)
    }
  }
  return out
}

export function assertFieldsAccess(access, paths, label = "Write") {
  if (!access.fields) return

  for (const path of paths) {
    if (!isAllowedField(path, access.fields)) {
      throw new Error(`${label} denied: field ${path}`)
    }
  }
}

export function projectFields(obj, fields) {
  if (!obj || !fields) return obj

  const out = {}
  copyMetaField(obj, out, "_id")
  copyMetaField(obj, out, "id")

  for (const field of fields) {
    const value = getByPath(obj, field)
    if (value !== undefined) setByPath(out, field, clone(value))
  }

  return out
}

export function changeWritePaths({ set, unset, obj }) {
  return [
    ...Object.keys(set ?? {}),
    ...(unset ?? []),
    ...objectPaths(obj)
  ].filter((path) => path !== "_id" && path !== "id")
}

export function filterChangeFields(change, fields) {
  if (!fields) return change

  if (change.action === "insert") {
    return { ...change, obj: projectFields(change.obj, fields) }
  }

  if (change.action === "delete") {
    return { ...change, old: projectFields(change.old, fields) }
  }

  if (change.action === "update") {
    const set = Object.fromEntries(
      Object.entries(change.set ?? {}).filter(([path]) => isAllowedField(path, fields))
    )
    const unset = (change.unset ?? []).filter((path) => isAllowedField(path, fields))

    if (Object.keys(set).length === 0 && unset.length === 0) return undefined
    return {
      ...change,
      set: Object.keys(set).length > 0 ? set : undefined,
      unset: unset.length > 0 ? unset : undefined
    }
  }

  return change
}

export function resolveUser(config, ctx) {
  return config.getUser(ctx)
}

function codeAccessDecision(access, action, ctx) {
  const tableRule = access?.[ctx.table]?.[action]
  const globalRule = access?.[action]

  return Promise.resolve(tableRule?.(ctx)).then((tableDecision) => {
    if (tableDecision !== undefined && tableDecision !== null) return tableDecision
    return globalRule?.(ctx)
  })
}

async function permissionDecisionFromDb(config, action, ctx) {
  const rules = ctx.permissionRules ?? await config.mongo
    .collection(config.permissionTable)
    .find({ table: ctx.table })
    .sort({ priority: -1 })
    .toArray()

  for (const rule of rules) {
    if (!matchesIf(ctx.obj ?? ctx.old, rule.if)) continue
    const decision = permissionPartDecision(rule[action], ctx.user)
    if (decision !== undefined && decision !== null) return decision
  }

  return undefined
}

function permissionPartDecision(part, user) {
  if (!part || !user) return undefined

  const users = part.users ?? []
  const groups = part.groups ?? []
  const userMatch = users.includes(user._id)
  const groupMatch = groups.some((group) => user.groups?.includes(group))

  if (!userMatch && !groupMatch) return undefined
  if ("action" in part && part.action === false) return { allowed: false }
  return { allowed: true, fields: part.fields }
}

function matchesIf(obj, condition) {
  if (!condition) return true
  if (!obj) return false

  return Object.entries(condition).every(([path, expected]) => getByPath(obj, path) === expected)
}

function normalizeDecision(decision) {
  if (typeof decision === "boolean") return { allowed: decision }
  if (typeof decision !== "object") return { allowed: Boolean(decision) }
  if ("action" in decision) return { allowed: decision.action !== false, fields: decision.fields }
  if ("allowed" in decision) return decision
  return { allowed: true, fields: decision.fields }
}

function isAllowedField(path, fields) {
  return fields.some((field) => path === field || path.startsWith(`${field}.`))
}

function copyMetaField(from, to, field) {
  if (field in from) to[field] = from[field]
}

function objectPaths(obj, prefix = "") {
  if (!obj) return []

  const paths = []
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isPlainObject(value)) {
      paths.push(...objectPaths(value, path))
    } else {
      paths.push(path)
    }
  }

  return paths
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}
