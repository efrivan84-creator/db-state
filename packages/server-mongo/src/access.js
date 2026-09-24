import { getByPath, setByPath } from "@db-state/core"

export async function assertAccess(config, action, ctx) {
  const access = await resolveAccess(config, action, ctx)
  if (!access.allowed) {
    throw new Error(`${action === "read" ? "Read" : "Write"} denied: ${ctx.table}`)
  }

  return access
}

// Права берутся только из access групп пользователя (слитого при логине).
// Динамические решения — дело хуков beforeRead / beforeWrite.
export async function resolveAccess(config, action, ctx) {
  // Пользователь мог быть разрешён вызывающим методом — не спрашиваем повторно.
  const user = "user" in ctx ? ctx.user : await resolveUser(config, ctx)
  const decision = await userAccessDecision(user?.access, action, { ...ctx, user, docId: ctx.id })

  return decision ?? { allowed: false }
}

// user.access is merged from the user's groups at login, e.g.
// {
//   fullaccess: 1,                 — special key: everything
//   zad: { read: {}, write: {} },  — full table access ({} matches all rows)
//   bill: {
//     read: { needact: true },     — a filter: only matching documents;
//                                    after merge it can be an array (any-of)
//     read_fields: ["fio"],        — field whitelist for reads
//     write: {},
//     write_fields: ["comm"]       — field whitelist for writes
//   }
// }
// Filter values support placeholders:
//   "$adminid" — the current user's id;
//   "$groupid" — matches any of the current user's group ids.
// The write filter is checked against the existing document for
// update/remove and against the new document for add.
async function userAccessDecision(access, action, ctx) {
  if (!access) return undefined
  if (flag(access.fullaccess)) return { allowed: true }

  const entry = access[ctx.table]
  if (entry == null || typeof entry !== "object") return undefined

  const filters = accessFilters(entry[action])
  if (!filters) return undefined

  const fields = entry[`${action}_fields`]
  const decision = { allowed: true, fields: Array.isArray(fields) ? fields : undefined }

  // {} совпадает со всем — решаем без чтения документа.
  if (filters.some(isEmptyFilter)) return decision

  // Документ уже в руках (load, update/remove) — проверяем его.
  const doc = action === "write" ? ctx.old ?? ctx.obj : ctx.obj ?? ctx.old
  if (doc !== undefined && doc !== null) {
    return filters.some((filter) => matchesAccessFilter(doc, filter, ctx.user)) ? decision : undefined
  }

  // Документа нет (sync) — база отвечает одним запросом сразу с фильтром права.
  if (typeof ctx.matchAccessFilters === "function") {
    return (await ctx.matchAccessFilters(filters, ctx.user)) ? decision : undefined
  }
  if (typeof ctx.loadDoc === "function") {
    const loaded = await ctx.loadDoc()
    return filters.some((filter) => matchesAccessFilter(loaded, filter, ctx.user)) ? decision : undefined
  }
  return undefined
}

// План чтения по user.access: право уходит прямо в Mongo-запрос, чтобы база
// сама вернула только разрешённые строки и только разрешённые поля.
// ctx.fields (из хука beforeRead) сужает набор полей поверх права.
export async function userReadPlan(config, ctx) {
  // Пользователь уже разрешён вызывающим методом — второй раз не спрашиваем.
  const user = "user" in ctx ? ctx.user : await resolveUser(config, ctx)
  const access = user?.access
  const hookFields = fieldList(ctx.fields)
  if (!access) return { mode: "none" }
  if (flag(access.fullaccess)) return { mode: "all", fields: hookFields }

  const entry = access[ctx.table]
  if (entry == null || typeof entry !== "object") return { mode: "none" }

  const filters = accessFilters(entry.read)
  if (!filters) return { mode: "none" }
  const fields = narrowFields(fieldList(entry.read_fields), hookFields)

  if (filters.some(isEmptyFilter)) return { mode: "all", fields }
  return { mode: "filter", query: accessFiltersQuery(filters, user), fields }
}

// Хук может только сузить список полей, но не расширить право.
function narrowFields(accessFields, hookFields) {
  if (!hookFields) return accessFields
  if (!accessFields) return hookFields
  return hookFields.filter((field) => isAllowedField(field, accessFields))
}

function fieldList(value) {
  return Array.isArray(value) ? value : undefined
}

// Условие Mongo из фильтров права: один фильтр — как есть, несколько — $or.
export function accessFiltersQuery(filters, user) {
  const resolved = filters.map((filter) => resolveFilterForQuery(filter, user))
  return resolved.length === 1 ? resolved[0] : { $or: resolved }
}

function resolveFilterForQuery(filter, user) {
  const out = {}
  for (const [path, value] of Object.entries(filter)) {
    out[path] = resolveQueryValue(value, user)
  }
  return out
}

function resolveQueryValue(value, user) {
  if (value === "$adminid") return user?._id
  if (value === "$groupid") return { $in: user?.groups ?? [] }
  // Массив значений в поле — «совпадает любое», как и при сверке документа
  // (valuesMatch ниже). Без $in он ушёл бы в Mongo как есть, а там это
  // «поле равно этому массиву»: право { _id: [101, 102] } не совпало бы ни
  // с одной строкой, и чтение по фильтру молча отдавало бы пусто — при том
  // что проверка уже прочитанного документа то же право принимает.
  if (Array.isArray(value)) return { $in: value.map((item) => resolveQueryValue(item, user)) }
  if (value && typeof value === "object") {
    const out = {}
    for (const [key, nested] of Object.entries(value)) out[key] = resolveQueryValue(nested, user)
    return out
  }
  return value
}

// Право — это документ-фильтр. Всё, что не объект, игнорируется:
// read: false / 0 / "" / 1 — не право, а значит полный запрет.
function isFilter(filter) {
  return Boolean(filter) && typeof filter === "object" && !Array.isArray(filter)
}

// Список фильтров права: объект — один фильтр, массив — any-of.
// Возвращает undefined, если права нет вообще.
function accessFilters(value) {
  if (isFilter(value)) return [value]
  if (!Array.isArray(value)) return undefined

  const filters = value.filter(isFilter)
  return filters.length > 0 ? filters : undefined
}

function isEmptyFilter(filter) {
  return isFilter(filter) && Object.keys(filter).length === 0
}

// Quick check for named methods and UI: without a document a filter counts as
// "has some access"; pass a document (and user for placeholders) to test rows.
export function accessAllows(access, table, action, doc, user) {
  if (!access) return false
  if (flag(access.fullaccess)) return true
  const entry = access[table]
  if (entry == null || typeof entry !== "object") return false
  const filters = accessFilters(entry[action])
  if (!filters) return false
  if (filters.some(isEmptyFilter)) return true
  if (doc === undefined) return true
  return filters.some((filter) => matchesAccessFilter(doc, filter, user))
}

export function matchesAccessFilter(doc, filter, user) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return false
  const entries = Object.entries(filter)
  if (entries.length === 0) return true
  if (!doc) return false

  return entries.every(([path, expected]) => {
    return valuesMatch(getByPath(doc, path), resolvePlaceholder(expected, user))
  })
}

function resolvePlaceholder(expected, user) {
  if (expected === "$adminid") return user?._id
  if (expected === "$groupid") return user?.groups ?? []
  return expected
}

function valuesMatch(value, expected) {
  if (Array.isArray(expected)) return expected.some((item) => valuesMatch(value, item))
  if (Array.isArray(value)) return value.includes(expected)
  return value === expected
}

function flag(value) {
  return value === 1 || value === true
}

export function assertFieldsAccess(access, paths, label = "Write") {
  if (!access.fields) return

  for (const path of paths) {
    // A top-level Mongo operator is an opaque query dependency rather than a
    // document path. It must never become allow-listable as if it were a field.
    if (path.startsWith("$") || !isAllowedField(path, access.fields)) {
      throw new Error(`${label} denied: field ${path}`)
    }
  }
}

// Поля, по которым фильтрует клиентский запрос.
//
// read_fields скрывает поле в ответе, но фильтровать по нему до сих пор было
// можно: запрос { secret: "x" } не возвращает поле, зато по наличию строки в
// результате его значение подбирается перебором. Поэтому пути фильтра
// проверяются тем же списком, что и вывод.
//
// $and/$or/$nor содержат обычные вложенные фильтры. Остальные корневые
// операторы ($expr/$where/$text/$jsonSchema/...) могут зависеть от полей,
// которые не представлены обычными ключами. Возвращаем сам оператор как
// непроницаемый путь: assertFieldsAccess всегда отклоняет такие маркеры.
const LOGICAL_FILTER_OPERATORS = new Set(["$and", "$or", "$nor"])

export function filterFields(filter, prefix = "") {
  if (Array.isArray(filter)) return filter.flatMap((item) => filterFields(item, prefix))
  if (!isPlainObject(filter)) return []

  const paths = []
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith("$")) {
      if (LOGICAL_FILTER_OPERATORS.has(key)) {
        paths.push(...filterFields(value, prefix))
      } else {
        paths.push(key)
      }
      continue
    }

    const path = prefix ? `${prefix}.${key}` : key
    // { addr: { $regex: ... } } — поле addr, а не вложенный документ.
    const nested = isPlainObject(value) && !hasOperatorKey(value)
      ? filterFields(value, path)
      : []

    if (nested.length > 0) paths.push(...nested)
    else paths.push(path)
  }

  return paths
}

function hasOperatorKey(value) {
  return Object.keys(value).some((key) => key.startsWith("$"))
}

export function projectFields(obj, fields) {
  if (!obj || !fields) return obj

  const out = {}
  copyMetaField(obj, out, "_id")

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
    // Патч может заменить родительский объект целиком — set: { sip: {...} }, —
    // а разрешены только его вложенные поля: ["sip.extension"]. Такой путь
    // не выбрасываем, а разворачиваем по разрешённым вложенным: иначе клиент
    // молча не получил бы изменение, которое ему положено. Разрешённого поля
    // в новом объекте нет — у клиента оно удаляется: объект заменён целиком.
    const set = {}
    const unset = new Set()
    for (const [path, value] of Object.entries(change.set ?? {})) {
      if (isAllowedField(path, fields)) {
        set[path] = value
        continue
      }
      for (const field of nestedFields(path, fields)) {
        const nested = getByPath(value, field.slice(path.length + 1))
        if (nested === undefined) unset.add(field)
        else set[field] = nested
      }
    }
    for (const path of change.unset ?? []) {
      if (isAllowedField(path, fields)) unset.add(path)
      else for (const field of nestedFields(path, fields)) unset.add(field)
    }

    if (Object.keys(set).length === 0 && unset.size === 0) return undefined
    const { set: ignoredSet, unset: ignoredUnset, ...base } = change
    return {
      ...base,
      ...(Object.keys(set).length > 0 ? { set } : {}),
      ...(unset.size > 0 ? { unset: [...unset] } : {})
    }
  }

  return change
}

export function resolveUser(config, ctx) {
  return config.getUser(ctx)
}

export function isAllowedField(path, fields) {
  return fields.some((field) => path === field || path.startsWith(`${field}.`))
}

// Разрешённые поля внутри пути: для "sip" из ["sip.extension", "name"] —
// ["sip.extension"].
function nestedFields(path, fields) {
  return fields.filter((field) => field.startsWith(`${path}.`))
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
