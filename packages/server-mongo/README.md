# @db-state/server-mongo

> **English** · [Русский](README.ru.md)

MongoDB-backed server for [db-state](https://github.com/efrivan84-creator/db-state): CRUD, append-only log, sync, WebSocket RPC, declarative permissions with field-level rules.

It exposes CRUD/sync behavior through WebSocket RPC only. There are no HTTP handlers in this package.

## What you get

- WebSocket RPC server for `load`, `getIds`, `getUnique`, `count`, `sync`, `add`, `update`, and `remove`.
- Mongo-backed app tables plus service tables `_user`, `_group`, and `_permission`.
- Password login and hash-based reconnect over the same WebSocket.
- Append-only `log` collection for realtime sync, audit trail, delete recovery, and time-travel reconstruction.
- Sync by `(time1, to]` log windows with session echo suppression.
- Read/write permission checks for every RPC, including service tables.
- Field-level permissions for reads, sync changes, inserts, and updates.
- Code access rules that can override or extend `_permission` rows and lazily load documents only when needed.
- Built-in socket hub plus an adapter hook for Redis/NATS-style multi-process broadcasts.

## Install

```sh
npm install @db-state/server-mongo mongodb ws
```

`mongodb` is an optional peer dependency — any duck-typed `MongoDatabaseLike` works (handy for tests with an in-memory mongo).

## Setup

```js
import { createDbStateServer } from "@db-state/server-mongo"

const dbState = createDbStateServer({
  mongo,
  tables: ["user", "order", "product"]
})
```

`_user`, `_group`, and `_permission` are added automatically. They are only known to the API; access is still denied unless code rules or `_permission` rules allow it.

Attach WebSocket clients from your own `ws` server:

```js
dbState.socket.addClient(ws, {
  user: {
    _id: "u1",
    groups: ["manager"]
  },
  userId: "u1",
  sessionId: "u1_abcd"
})
```

## Required indexes

Create these indexes in production:

```js
await mongo.collection("log").createIndex({ createdAt: 1, logId: 1 })
await mongo.collection("_permission").createIndex({ table: 1, priority: -1 })
```

Add normal Mongo indexes for app queries used by `getIds`, `count`, and `getUnique`:

```js
await mongo.collection("order").createIndex({ status: 1, createdAt: -1 })
```

## WebSocket RPC

Client request:

```js
{
  type: "dbstate:rpc",
  id: "rpc1",
  method: "update",
  payload: {
    table: "order",
    id: "o1",
    set: { status: "open" },
    sessionId: "u1_abcd"
  }
}
```

Server response:

```js
{
  type: "dbstate:rpc_result",
  id: "rpc1",
  result: { ok: true, change }
}
```

Supported methods:

```js
load
getIds
getUnique
count
sync
update
add
remove
```

RPC is denied until the socket is authorized.

### Method summary

| Method | Purpose |
|---|---|
| `load` | Reads one permitted document, projected by `read.fields`. |
| `getIds` | Returns permitted ids after `filter`, `sort`, `skip`, and `limit`. |
| `getUnique` | Returns unique permitted values for one field. |
| `count` | Counts permitted documents for a filter. |
| `sync` | Returns visible log changes newer than the client's cursor. |
| `add` | Inserts a document after `write` and `write.fields` checks. |
| `update` | Applies `set` / `unset` after `write` and `write.fields` checks. |
| `remove` | Deletes after document-level `write`; stores deleted object in `change.old`. |

## Auth

Users live in `_user`:

```js
{
  _id: "u1",
  login: "ivan",
  passwordHash: "...",
  hash: "auth-secret",
  groups: ["manager"],
  disabled: false
}
```

Login request:

```js
{
  type: "dbstate:login",
  id: "login1",
  login: "ivan",
  password: "password"
}
```

Login response:

```js
{
  type: "dbstate:login_result",
  id: "login1",
  ok: true,
  userId: "u1",
  hash: "auth-secret",
  groups: ["manager"]
}
```

`hash` is reused across logins. A second browser tab or device logging in as the same user receives the existing `_user.hash`; it does not invalidate already opened tabs. If `_user.hash` is missing, the server creates it on the first successful login.

Reconnect authorization:

```js
{
  type: "dbstate:auth",
  id: "auth1",
  userId: "u1",
  hash: "auth-secret"
}
```

Logout on one device is local: the client forgets `hash`.

Logout everywhere: rotate `_user.hash` on the server.

The default password adapter uses PBKDF2 from Node `crypto`. You can replace it:

```js
createDbStateServer({
  mongo,
  tables,
  password: {
    hash: async (password) => "...",
    verify: async (password, passwordHash) => true
  }
})
```

## Permission Tables

Access is denied by default.

The server checks access in this order:

1. Code rule for `table + docId`.
2. Code rule for `table`.
3. `_permission` rule for matching `table` and `if`.
4. Deny.

Permission document:

```js
{
  _id: "perm_order_open",
  table: "order",
  priority: 10,

  if: {
    status: "open"
  },

  read: {
    users: ["u1"],
    groups: ["manager"],
    action: true,
    fields: ["_id", "status", "total"]
  },

  write: {
    users: [],
    groups: ["admin"],
    action: true,
    fields: ["status", "comment"]
  }
}
```

If `if` is missing, the rule applies to the whole table.

If `action` is missing, matching users/groups resolve to `true`.

Use `action: false` for explicit deny.

If `fields` is missing, all fields are allowed. If `fields` is present:

- `read.fields` projects `load()` results.
- `read.fields` also projects `insert`, `update`, and `delete.old` changes returned by `sync()`.
- `write.fields` validates fields on `add()` and `update()`.
- `remove()` is controlled by document-level `write`; use a code rule with `action === "delete"` when delete needs a stricter rule.

Forbidden write fields reject the whole operation.

## Code Access Rules

Code rules can override database permissions:

```js
const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  access: {
    table: {
      order: {
        read: async ({ user, loadDoc }) => {
          const obj = await loadDoc()
          return obj.ownerId === user._id
        },
        write: async ({ user, obj, set }) => false
      }
    },
    doc: {
      order: {
        o1: {
          read: async () => true
        }
      }
    }
  }
})
```

During `sync()`, changed documents are loaded lazily. If `_permission` rules for a table have no `if`, sync can decide access from `table + user/groups` without reading the changed document. Code rules that need the document should call `ctx.loadDoc()`; this performs the Mongo `findOne` only when the rule actually asks for it.

`write` covers all mutating operations:

```text
insert
update
delete
```

Use the `action` field in code rules when an operation needs a stricter decision:

```js
const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  access: {
    table: {
      order: {
        write: async ({ action, user }) => {
          if (action === "insert") return true
          if (action === "update") return true
          if (action === "delete") return user.groups.includes("admin")
          return undefined
        }
      }
    }
  }
})
```

Return values:

- `true` - allow.
- `false` - deny.
- `{ action: true, fields: ["status"] }` - allow with field restrictions.
- `undefined` or `null` - no decision, continue to the next layer.

## Delete Logs

`remove()` stores the deleted object in `change.old`.

This allows permission checks and audit after the original document is gone.

Every log entry stores the actor id:

```js
{
  userId: "u1"
}
```

## Sync and audit log

Every successful write appends one compact log row:

```js
{
  logId,
  createdAt,
  table,
  id,
  action,      // insert | update | delete
  set,
  unset,
  obj,         // full inserted document
  old,         // full deleted document
  sessionId,
  userId
}
```

Clients call `sync({ from, sessionId })`. The server reads `createdAt > from && createdAt <= to`, excludes the caller session, applies read permissions, filters forbidden fields, and returns `{ to, changes }`.

For high-write systems, keep `syncLimit` high enough for one sync window or add cursor continuation by `{ createdAt, logId }`.

## Useful links

- Full docs: [docs/en](../../docs/en/README.md)
- Server setup: [docs/en/server/setup.md](../../docs/en/server/setup.md)
- Permissions: [docs/en/server/permissions.md](../../docs/en/server/permissions.md)
- Sync protocol: [docs/en/architecture/sync-protocol.md](../../docs/en/architecture/sync-protocol.md)

## Internal Files

- `index.js` - CRUD, sync, log writing, public factory.
- `access.js` - code rules and `_permission` resolution.
- `rpc.js` - WebSocket RPC method dispatch.
- `socket.js` - WebSocket client registry and broadcast.
- `auth.js` - login/hash auth and password adapter.
