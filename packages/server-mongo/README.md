# @db-state/server-mongo

> **English** · [Русский](README.ru.md)

MongoDB-backed server for [db-state](https://github.com/efrivan84-creator/db-state): CRUD, append-only log, sync, WebSocket RPC, declarative permissions with field-level rules.

It exposes CRUD/sync behavior through WebSocket RPC only. There are no HTTP handlers in this package.

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

## Internal Files

- `index.js` - CRUD, sync, log writing, public factory.
- `access.js` - code rules and `_permission` resolution.
- `rpc.js` - WebSocket RPC method dispatch.
- `socket.js` - WebSocket client registry and broadcast.
- `auth.js` - login/hash auth and password adapter.
