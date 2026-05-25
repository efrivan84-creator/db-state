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

      attachUser(client, { ...user, hash })
      send(client, DB_STATE_MESSAGES.loginResult, message.id, {
        ok: true,
        userId: user._id,
        hash,
        groups: user.groups ?? []
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

      attachUser(client, user)
      send(client, DB_STATE_MESSAGES.authResult, message.id, {
        ok: true,
        userId: user._id,
        groups: user.groups ?? []
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

function attachUser(client, user) {
  client.user = {
    _id: user._id,
    login: user.login,
    groups: user.groups ?? []
  }
  client.userId = user._id
}

function send(client, type, id, payload) {
  client.send?.(JSON.stringify({ type, id, ...payload }))
}
