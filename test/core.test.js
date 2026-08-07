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
      u1: { _id: "u1", name: "Ivan", profile: { city: "Moscow" } }
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
    obj: { _id: "u2", name: "Pavel" }
  })

  applyChange(tables, {
    table: "user",
    id: "u1",
    action: "delete"
  })

  assert.deepEqual(tables, {
    user: {
      u2: { _id: "u2", name: "Pavel" }
    }
  })
})

test("applyChange keys records by _id when the change carries no object", () => {
  const tables = {}

  // insert без obj и update по отсутствующей записи — обе ветки создают
  // документ сами; ключ должен быть _id, как требует BaseDoc.
  applyChange(tables, { table: "order", id: "o1", action: "insert" })
  applyChange(tables, { table: "order", id: "o2", action: "update", set: { status: "new" } })

  assert.deepEqual(tables, {
    order: {
      o1: { _id: "o1" },
      o2: { _id: "o2", status: "new" }
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
    _id: "log1",
    createdAt: "2026-05-21T10:00:00.000Z",
    table: "order",
    id: "o1",
    action: "delete",
    old: { _id: "o1", status: "open" },
    user: { _id: "u1", groups: ["admin"] },
    userId: "u1",
    set: undefined,
    unset: null,
    obj: null,
    sessionId: undefined
  })

  assert.deepEqual(change, {
    _id: "log1",
    createdAt: "2026-05-21T10:00:00.000Z",
    table: "order",
    id: "o1",
    action: "delete",
    old: { _id: "o1", status: "open" },
    userId: "u1"
  })
})

test("normalizeTables deduplicates explicit tables without adding service tables implicitly", () => {
  assert.deepEqual(normalizeTables(["order", "order"]), ["order"])
  assert.deepEqual(normalizeTables(["order"], ["_user", "_group"]), [
    "order",
    "_user",
    "_group",
  ])
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
