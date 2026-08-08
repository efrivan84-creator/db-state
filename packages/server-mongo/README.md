# @db-state/server-mongo

> **English** · [Русский](README.ru.md)

MongoDB-backed server for [db-state](https://github.com/efrivan84-creator/db-state): CRUD, append-only log, sync, WebSocket RPC, group-based permissions (an `access` object) with row filters and field whitelists, plus lifecycle hooks.

It exposes CRUD/sync behavior through WebSocket RPC only. There are no HTTP handlers in this package.

## What you get

- WebSocket RPC server for `load`, `getIds`, `getUnique`, `count`, `sync`, `add`, `update`, and `remove`.
- Mongo-backed app tables plus service tables `_user` and `_group`.
- Password login and hash-based reconnect over the same WebSocket.
- Append-only `log` collection for realtime sync, audit trail, delete recovery, and time-travel reconstruction.
- Sync by `(time1, to]` log windows with session echo suppression.
- Read/write permission checks for every RPC from the `access` object of the user's groups; row filters are pushed into the Mongo query.
- Field-level permissions for reads, sync changes, inserts, and updates.
- Hooks around every read and write: rewrite the query, narrow the fields, allow or deny with a reason, audit errors.
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

`_user` and `_group` are not exposed through CRUD/RPC automatically. List them in `tables` explicitly when the admin UI needs them; access is still denied until a hook or the group `access` allows it.

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
await mongo.collection("log").createIndex({ createdAt: 1, _id: 1 })
await mongo.collection("_user").createIndex({ login: 1 }, { unique: true, sparse: true })
await mongo.collection("_user").createIndex({ email: 1 }, { unique: true, sparse: true })
await mongo.collection("_user").createIndex({ phone: 1 }, { unique: true, sparse: true })
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
  result: { ok: true, change },
  meta: { fieldsFiltered: true } // optional
}
```

`meta` carries only what the server already knows — nothing is counted or re-queried to fill it. `fieldsFiltered: true` means a read field whitelist applies, so the returned fields are limited. How many rows or changes a read permission hid is never reported: the client has no use for it, and counting it would cost an extra query. The normal `result` shape stays unchanged.

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
| `load` | Reads one permitted document, projected by `read_fields`. |
| `getIds` | Returns permitted ids after `filter`, `sort`, `skip`, and `limit`. |
| `getUnique` | Returns unique permitted values for one field. |
| `count` | Counts permitted documents for a filter. |
| `sync` | Returns visible log changes newer than the client's cursor. |
| `add` | Inserts a document after `write` and `write_fields` checks. |
| `update` | Applies `set` / `unset` after `write` and `write_fields` checks. |
| `remove` | Deletes after document-level `write`; stores deleted object in `change.old`. |

For read RPCs, the WebSocket `dbstate:rpc_result` envelope may include `meta.fieldsFiltered = true` without changing `result`, meaning field-level read rules limit the returned properties. Hidden rows are not reported.

## Custom RPC methods

Besides the standard CRUD/sync, named server methods are declared as files in `methodsDir` — the method name becomes the file path.

### `methodsDir`

```js
const dbState = createDbStateServer({
  mongo,
  tables: ["zad"],
  methodsDir: import.meta.dirname + "/rpc"
})
```

`methodsDir` accepts a path string or a file URL. A relative path like `"./rpc"`
resolves from the process cwd — anchoring to the module via `import.meta.dirname` is safer.

`"zad.get-num"` → `rpc/zad/get-num.js`, the file default-exports the handler:

```js
// rpc/zad/get-num.js
export default async ({ body, user, db }) => {
  const [last] = await db.collection("zad").find({}).sort({ num: -1 }).limit(1).toArray()
  return { num: (last?.num ?? 0) + 1 }
}
```

- The file is imported lazily on the first call and re-checked against its mtime at most every `reloadCheckMs` (default 60s), so edits apply without a restart.
- Every file method receives `db` (this server's Mongo), `api` (the db-state server: `api.add`/`api.update` write with log and broadcast) and `user` (from `client.user`) by default. Need more — `methodsContext: {...}` spreads on top (same-named keys override the defaults).
- Name segments are validated (`[a-z0-9_-]`, dot-separated): a client-supplied name can never leave the directory.
- Built-in method names (`load`, `sync`, ...) take precedence; a file cannot shadow them.
- RPC is rejected until the socket is authorized, same as for built-in methods.
- Permission checks and the change log only apply to standard CRUD: a method writing to the database directly owns its permissions, audit and broadcast — or calls `api.add` / `api.update`, which do all three.
- Reload uses `import` with `?v=mtime`: old module copies stay in memory (ESM cannot be evicted). Production files do not change, development reloads are negligible; handlers must not keep module-level state.

## Auth

Users live in `_user`:

```js
{
  _id: "u1",
  login: "ivan",
  email: "ivan@example.com",
  phone: "+79990001122",
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
  groups: ["manager"],
  access: { order: { read: {} } }
}
```

`hash` is reused across logins. A second browser tab or device logging in as the same user receives the existing `_user.hash`; it does not invalidate already opened tabs. If `_user.hash` is missing, the server creates it on the first successful login.

By default `dbstate:login` matches `_user.login`. To accept other identifiers, configure `authLoginFields`:

```js
createDbStateServer({
  mongo,
  tables,
  authLoginFields: ["login", "name", "email", "phone"],
  normalizeAuthLogin: (value, field) => {
    const text = String(value).trim()
    if (field === "email") return text.toLowerCase()
    if (field === "phone") return text.replace(/\D/g, "")
    return text
  }
})
```

The client still calls `state.login(value, password)`; the server normalizes that value per field and searches the configured fields. Store normalized identifier values in `_user` too, for example lowercase emails and canonical phone digits.

For production, add sparse unique indexes for every identifier field you allow, for example `_user.email` and `_user.phone`.

If a normalized identifier matches multiple active users, login fails with the same generic `Invalid login or password` response and the server calls:

```js
onAuthWarning?.({
  type: "ambiguous_auth_login",
  login,
  normalized,
  fields,
  count,
  client
})
```

You can rate-limit login and hash auth with a hook. Return `false` to reject the attempt:

```js
createDbStateServer({
  mongo,
  tables,
  authRateLimit: async ({ type, login, userId, client }) => {
    return await limiter.allow(client.ip ?? login ?? userId)
  }
})
```

Rate-limited attempts return `Too many attempts`.

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

## Permissions: group `access`

Access is denied by default.

Permissions are stored as data on a group (`_group`), an object of arbitrary nesting:

```js
{
  _id: "montaj",
  name: "Installers",
  access: {
    zad: { read: {}, write: {} },    // full table access ({} = all rows)
    bill: { read: {} },              // read only, all rows and fields
    admin: {
      read: { enable: true },        // filter: only matching documents are visible
      read_fields: ["fio", "tel"],   // and only these fields
      write: {},                     // {} = edit any row
      write_fields: ["tel"]          //   but only these fields
    },
    fullaccess: 1                    // special key: access to everything
  }
}
```

At login the server merges the `access` of all the user's groups (plus a
personal `access` on the `_user` document, if any) and attaches the result as
`user.access`. Merging is additive only, there are no deny rules: filters from different
groups combine into an any-of set, `{}` (all rows) beats any filter. The object is returned in `login_result`/`auth_result`, so the
client can hide UI sections without extra requests. Changing a group's rights
applies on the next login or reconnect.

The server checks permissions in this order:

1. Code rule for the table (`access[table][action]`).
2. Global code rule (`access[action]`).
3. `user.access`: `fullaccess`, then the `<table>.<action>` filter.
4. Deny.

Action mapping: `read` — `load`, `getIds`, `getUnique`, `count` and change
visibility in `sync`; `write` — `add`, `update`, `remove`.

### Filters and fields

A `read`/`write` value is a **document filter** (dot paths): `{}` matches
everything, i.e. grants the action on the whole table; after group merge it
may be an array of filters (a document passes when at least one matches).

Placeholders in filter values:

- `"$adminid"` — the current user's id;
- `"$groupid"` — matches any of the user's groups.

```js
{ zad: { read: { master: "$adminid" } } }   // a technician sees only their tickets
{ zad: { read: { dep: "$groupid" } } }      // a department sees its own area
```

The `write` filter is checked against the **existing** document for
`update`/`remove` and the **new** one for `add`. `read_fields`/`write_fields`
are field whitelists: reads project documents and sync changes, writes reject
other paths. On merge field lists are united, and a grant without a field
limit removes the limit entirely.

**Filters are evaluated by the database itself, in a single query:**

- lists (`getIds`, `count`, `getUnique`) put the access filter straight into
  the Mongo query (`$or` for several), so the database returns only permitted
  rows, and `getIds` requests only `_id` (projection); `count` uses `countDocuments` without fetching data (when the table
  has no code read rules — otherwise the per-row path is used);
- `load` checks the access filter with the same `findOne`, and with
  `read_fields` asks Mongo only for the allowed fields (projection);
  `getUnique` fetches only the requested field;
- `sync` checks a changed document with one `findOne` that already includes
  the access filter;
- `{}` grants are decided without touching the database at all;
- `"$groupid"` becomes `{ $in: groups }` in the query.

Check the object manually (e.g. inside a named method):

```js
import { accessAllows } from "@db-state/server-mongo"

accessAllows(user.access, "bill", "write")            // any access at all
accessAllows(user.access, "zad", "read", doc, user)   // check a concrete document
```

Field-level rights and row-level conditions are expressed with code rules
(next section) — they can return `{ fields: [...] }` or inspect the document.

## Hooks

Hooks are where your application steps into the built-in commands: rewrite the
query, narrow the fields, allow or deny, enrich the response.

```js
const dbState = createDbStateServer({ mongo, tables: ["order"], hooksDir: "./hooks" })
```

```js
// hooks/beforeRead.js — applies to every table
export default (ctx) => {
  ctx.filter = { ...ctx.filter, tenantId: ctx.user.tenantId }
}

// hooks/order/beforeWrite.js — only for the order table
export default (ctx) => {
  if (ctx.method === "remove" && !ctx.user.groups.includes("admin")) {
    return { allowed: false, reason: "Only an admin can delete orders" }
  }
  if (ctx.method === "update") ctx.set.updatedBy = ctx.user._id
}
```

Hook names:

```text
beforeRead   afterRead   errorRead
beforeWrite  afterWrite  errorWrite
```

A file in the root applies to every table, a file in a subfolder only to that
table; the shared one runs first. Files are re-checked against their mtime at
most every `reloadCheckMs` (default 60s), so an edit applies without a restart.

### What to return

| Return | Effect |
| --- | --- |
| `undefined` | No decision — the user's group access decides |
| `true` | Allowed; group access is skipped |
| `false` | Denied with `Read denied: <table>` |
| `{ allowed: false, reason }` | Denied; the reason is sent to the client |

Mutations of `ctx` apply regardless of the returned value, so a hook can rewrite
the query and still leave the decision to the group access.

`beforeRead` may change `ctx.filter`, `ctx.sort`, `ctx.skip`, `ctx.limit` and
`ctx.fields` (field projection) before Mongo is queried. `beforeWrite` may change
`ctx.obj`, `ctx.set` and `ctx.unset` before the permission check and the save.

`afterWrite` runs after the Mongo write, the append-log and the broadcast, so it
cannot deny; `ctx.change` and `ctx.result` are available.

`errorRead` / `errorWrite` receive `ctx.error` and do not swallow it — the
original error still reaches the caller.

Hooks contributed by mounted modules run before the application hook of the same
name; the first explicit decision stops the chain.

## Delete Logs

`remove()` stores the deleted object in `change.old`.

This allows permission checks and audit after the original document is gone.

Every log entry stores the actor id:

```js
{
  userId: "u1"
}
```

## Server-owned info fields

Client writes cannot set or remove `info` fields. On `add`, the server strips `info` from the input object and writes:

```js
{
  info: {
    makeid: user._id,
    makedata: serverTime
  }
}
```

On `update`, the server strips `info` / `info.*` from client `set` and `unset`, then writes:

```js
{
  "info.editid": user._id,
  "info.editdata": serverTime
}
```

These fields are stored in the MongoDB document, so create/edit metadata cannot be forged by the client. They are not written to the log: who and when are the log entry's own `userId` and `createdAt`.

## Sync and audit log

Every successful write appends one compact log row:

```js
{
  _id,
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

Clients call `sync({ from, sessionId })`. The server reads at most 12 hours of log time, excludes the caller session, applies read permissions, filters forbidden fields, and returns `{ to, changes, hasMore? }`. The client follows `hasMore` windows automatically.

When `from` is more than 20 days old, the server returns `reset: true`; the client clears its local cache and reloads current state instead of replaying old log rows.

## Useful links

- Full docs: [docs/en](../../docs/en/README.md)
- Server setup: [docs/en/server/setup.md](../../docs/en/server/setup.md)
- Permissions: [docs/en/server/permissions.md](../../docs/en/server/permissions.md)
- Sync protocol: [docs/en/architecture/sync-protocol.md](../../docs/en/architecture/sync-protocol.md)

## Internal Files

- `index.js` - CRUD, sync, log writing, public factory.
- `access.js` - code rules, `accessAllows` and field-level filtering.
- `hooks.js` - server read/write lifecycle hook runner.
- `rpc.js` - WebSocket RPC method dispatch.
- `socket.js` - WebSocket client registry and broadcast.
- `auth.js` - login/hash auth and password adapter.
