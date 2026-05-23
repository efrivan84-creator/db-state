import assert from "node:assert/strict"
import test from "node:test"

import {
  applyChange,
  createChange,
  createSessionId,
  DB_STATE_MESSAGES,
  filterSyncChanges,
  getByPath,
  normalizeTables,
  setByPath
} from "../packages/core/src/index.js"

test("setByPath creates nested objects and getByPath reads them", () => {
  const target = {}

  setByPath(target, "profile.name", "Ivan")
  setByPath(target, "profile.addr.city", "Moscow")

  assert.deepEqual(target, {
    profile: {
      name: "Ivan",
      addr: {
        city: "Moscow"
      }
    }
  })
  assert.equal(getByPath(target, "profile.addr.city"), "Moscow")
})

test("applyChange updates, inserts, and deletes table records", () => {
  const tables = {
    user: {
      u1: { id: "u1", name: "Ivan", profile: { city: "Moscow" } }
    }
  }

  applyChange(tables, {
    table: "user",
    id: "u1",
    action: "update",
    set: { name: "Anna", "profile.city": "Tver" }
  })

  applyChange(tables, {
    table: "user",
    id: "u2",
    action: "insert",
    obj: { id: "u2", name: "Pavel" }
  })

  applyChange(tables, {
    table: "user",
    id: "u1",
    action: "delete"
  })

  assert.deepEqual(tables, {
    user: {
      u2: { id: "u2", name: "Pavel" }
    }
  })
})

test("filterSyncChanges returns changes inside the server time window and excludes current session", () => {
  const changes = [
    createChange({ table: "user", id: "old", action: "update", createdAt: "2026-05-21T10:00:00.000Z" }),
    createChange({ table: "user", id: "own", action: "update", createdAt: "2026-05-21T10:00:01.000Z", sessionId: "s1" }),
    createChange({ table: "user", id: "remote", action: "update", createdAt: "2026-05-21T10:00:02.000Z", sessionId: "s2" }),
    createChange({ table: "user", id: "future", action: "update", createdAt: "2026-05-21T10:00:03.000Z", sessionId: "s2" })
  ]

  const result = filterSyncChanges(changes, {
    from: "2026-05-21T10:00:00.000Z",
    to: "2026-05-21T10:00:02.000Z",
    sessionId: "s1"
  })

  assert.deepEqual(result.map((change) => change.id), ["remote"])
})

test("createSessionId keeps the user id prefix and random suffix", () => {
  const sessionId = createSessionId("user1", () => "abcdefghij")

  assert.equal(sessionId, "user1_abcdefghij")
})

test("createChange keeps compact audit fields", () => {
  const change = createChange({
    table: "order",
    id: "o1",
    action: "delete",
    old: { _id: "o1", status: "open" },
    user: { _id: "u1", groups: ["admin"] },
    userId: "u1"
  })

  assert.deepEqual(change.old, { _id: "o1", status: "open" })
  assert.equal(change.userId, "u1")
  assert.equal("user" in change, false)
})

test("normalizeTables always includes service tables", () => {
  assert.deepEqual(normalizeTables(["order"]), ["order", "_user", "_group", "_permission"])
  assert.deepEqual(normalizeTables(["_user", "order"]), ["_user", "order", "_group", "_permission"])
})

test("DB_STATE_MESSAGES contains every reserved protocol message name", () => {
  assert.deepEqual(DB_STATE_MESSAGES, {
    hello: "dbstate:hello",
    changesAvailable: "dbstate:changes_available",
    forceResync: "dbstate:force_resync",
    error: "dbstate:error",
    rpc: "dbstate:rpc",
    rpcResult: "dbstate:rpc_result",
    rpcError: "dbstate:rpc_error",
    login: "dbstate:login",
    loginResult: "dbstate:login_result",
    loginError: "dbstate:login_error",
    auth: "dbstate:auth",
    authResult: "dbstate:auth_result",
    authError: "dbstate:auth_error",
    logout: "dbstate:logout",
    logoutResult: "dbstate:logout_result",
    socketOpen: "dbstate:socket_open",
    socketClose: "dbstate:socket_close"
  })
})
