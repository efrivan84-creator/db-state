import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto"

import { DB_STATE_MESSAGES } from "@db-state/core"

export function createAuth(config) {
  return {
    async login(client, message) {
      const user = await config.mongo.collection(config.userTable).findOne({
        login: message.login,
        disabled: { $ne: true }
      })

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
