import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto"

import { DB_STATE_MESSAGES } from "@db-state/core"

export function createAuth(config) {
  return {
    async login(client, message) {
      if (await isRateLimited(config, { type: "login", login: message.login, client })) {
        send(client, DB_STATE_MESSAGES.loginError, message.id, { error: "Too many attempts" })
        return
      }

      const users = await config.mongo.collection(config.userTable)
        .find(loginFilter(config, message.login))
        .limit(2)
        .toArray()
      const user = users.length === 1 ? users[0] : undefined

      if (users.length > 1) {
        config.onAuthWarning?.({
          type: "ambiguous_auth_login",
          login: message.login,
          normalized: normalizedAuthLoginValues(config, message.login),
          fields: config.authLoginFields,
          count: users.length,
          client
        })
      }

      if (!user || !(await config.password.verify(message.password, user.passwordHash))) {
        send(client, DB_STATE_MESSAGES.loginError, message.id, { error: "Invalid login or password" })
        return
      }

      const hash = user.hash || config.createAuthHash()
      if (!user.hash) {
        await config.mongo.collection(config.userTable).updateOne(
          { _id: user._id },
          { $set: { hash } },
          { upsert: false }
        )
      }

      attachUser(client, { ...user, hash }, config)
      client.user.access = await mergeUserAccess(config, user)
      send(client, DB_STATE_MESSAGES.loginResult, message.id, {
        ok: true,
        userId: user._id,
        login: client.user.login,
        hash,
        groups: user.groups ?? [],
        access: client.user.access
      })
    },

    async auth(client, message) {
      if (await isRateLimited(config, { type: "auth", userId: message.userId, client })) {
        send(client, DB_STATE_MESSAGES.authError, message.id, { error: "Too many attempts" })
        return
      }

      const user = await config.mongo.collection(config.userTable).findOne({
        _id: message.userId,
        hash: message.hash,
        disabled: { $ne: true }
      })

      if (!user) {
        send(client, DB_STATE_MESSAGES.authError, message.id, { error: "Unauthorized" })
        return
      }

      attachUser(client, user, config)
      client.user.access = await mergeUserAccess(config, user)
      send(client, DB_STATE_MESSAGES.authResult, message.id, {
        ok: true,
        userId: user._id,
        login: client.user.login,
        groups: user.groups ?? [],
        access: client.user.access
      })
    },

    logout(client, message) {
      delete client.user
      delete client.userId
      send(client, DB_STATE_MESSAGES.logoutResult, message.id, { ok: true })
    }
  }
}

export const defaultPassword = {
  hash(password) {
    const salt = randomBytes(16).toString("hex")
    const hash = pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex")
    return `pbkdf2:${salt}:${hash}`
  },

  verify(password, stored) {
    const [kind, salt, expected] = String(stored).split(":")
    if (kind !== "pbkdf2" || !salt || !expected) return false

    const actual = pbkdf2Sync(password, salt, 120000, 32, "sha256")
    const expectedBuffer = Buffer.from(expected, "hex")
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer)
  }
}

export function defaultAuthHash() {
  return randomBytes(32).toString("hex")
}

export function hashValue(value) {
  return createHash("sha256").update(String(value)).digest("hex")
}

// Merges access objects of the user's groups, then the user's own access on
// top. Merging is additive only, there are no deny rules:
//   filters from different groups combine into an any-of array,
//   {} (all rows) beats any filter;
//   *_fields lists are united; a grant without a fields limit removes the limit.
export async function mergeUserAccess(config, user) {
  const access = {}
  for (const groupId of user.groups ?? []) {
    const group = await config.mongo.collection(config.groupTable).findOne({ _id: groupId })
    mergeAccess(access, group?.access)
  }
  mergeAccess(access, user.access)
  return access
}

function mergeAccess(target, extra) {
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (key === "fullaccess") {
      if (flag(value)) target.fullaccess = 1
      continue
    }
    target[key] = mergeTableEntry(target[key], value)
  }
  return target
}

function mergeTableEntry(current, extra) {
  if (extra == null || typeof extra !== "object") return current
  const base = current && typeof current === "object" ? current : undefined

  // Все действия, какие есть в данных, а не только read и write: полномочия
  // именованных методов (bill.pay, olt.manage) проверяются тем же
  // accessAllows и при слиянии групп теряться не должны. *_fields — не
  // действие, а ограничение полей действия, его сливает mergeAction.
  const actions = new Set([...Object.keys(base ?? {}), ...Object.keys(extra)])
  const out = {}
  for (const action of actions) {
    if (action.endsWith("_fields")) continue
    const merged = mergeAction(base, extra, action)
    if (merged.value !== undefined) out[action] = merged.value
    if (merged.fields) out[`${action}_fields`] = merged.fields
  }
  return Object.keys(out).length > 0 ? out : current
}

function mergeAction(a, b, action) {
  // Право даёт только объект-фильтр; всё остальное игнорируется.
  const af = toFilters(a?.[action])
  const bf = toFilters(b?.[action])
  if (af.length === 0 && bf.length === 0) return { value: undefined }

  const fields = mergeActionFields(a, b, action, { aGrants: af.length > 0, bGrants: bf.length > 0 })
  const filters = dedupeFilters([...af, ...bf])
  if (filters.some(isEmptyFilter)) return { value: {}, fields }
  return { value: filters.length === 1 ? filters[0] : filters, fields }
}

// Источник, дающий право без ограничения полей, снимает ограничение целиком.
function mergeActionFields(a, b, action, { aGrants, bGrants }) {
  const af = a?.[`${action}_fields`]
  const bf = b?.[`${action}_fields`]
  if ((aGrants && !isFieldList(af)) || (bGrants && !isFieldList(bf))) return undefined
  if (!aGrants) return isFieldList(bf) ? [...bf] : undefined
  if (!bGrants) return isFieldList(af) ? [...af] : undefined
  return [...new Set([...af, ...bf])]
}

function isFieldList(value) {
  return Array.isArray(value)
}

function toFilters(value) {
  if (isFilter(value)) return [value]
  return Array.isArray(value) ? value.filter(isFilter) : []
}

function isFilter(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isEmptyFilter(filter) {
  return isFilter(filter) && Object.keys(filter).length === 0
}

function dedupeFilters(filters) {
  const seen = new Set()
  const out = []
  for (const filter of filters) {
    const key = JSON.stringify(filter)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(filter)
  }
  return out
}

function flag(value) {
  return value === 1 || value === true
}

function loginFilter(config, login) {
  const fields = config.authLoginFields ?? ["login"]
  const normalized = normalizedAuthLoginValues(config, login)
  const matches = fields.map((field) => ({ [field]: normalized[field] }))
  const active = { disabled: { $ne: true } }
  if (matches.length === 1) return { ...matches[0], ...active }
  return { ...active, $or: matches }
}

function normalizedAuthLoginValues(config, login) {
  return Object.fromEntries((config.authLoginFields ?? ["login"]).map((field) => [
    field,
    config.normalizeAuthLogin(login, field)
  ]))
}

async function isRateLimited(config, ctx) {
  if (!config.authRateLimit) return false
  return await config.authRateLimit(ctx) === false
}

function attachUser(client, user, config) {
  client.user = {
    _id: user._id,
    login: userLogin(user, config),
    groups: user.groups ?? [],
    emailVerified: user.emailVerified,
    phoneVerified: user.phoneVerified
  }
  client.userId = user._id
}

// Пользователь может входить по любому из authLoginFields — берём первое
// заполненное поле, чтобы клиент показал, под кем вошли.
function userLogin(user, config) {
  for (const field of config?.authLoginFields ?? ["login"]) {
    if (user[field]) return String(user[field])
  }

  return user.login ?? undefined
}

function send(client, type, id, payload) {
  client.send?.(JSON.stringify({ type, id, ...payload }))
}
