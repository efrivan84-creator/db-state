# db-state

> **English** · [Русский](README.ru.md)

[![npm @db-state/vue](https://img.shields.io/npm/v/@db-state/vue?label=%40db-state%2Fvue)](https://www.npmjs.com/package/@db-state/vue)
[![npm @db-state/server-mongo](https://img.shields.io/npm/v/@db-state/server-mongo?label=%40db-state%2Fserver-mongo)](https://www.npmjs.com/package/@db-state/server-mongo)
[![license](https://img.shields.io/npm/l/@db-state/vue)](LICENSE)

Reactive database state for Vue 3 + MongoDB.

db-state lets page code read MongoDB documents like normal Vue state:

```js
const user = state.user.load(userId)

user.name
user.email
user.profile.city
```

The object is reactive. If another client changes the same row, the server writes the change to the log, sends a WebSocket notification, the client syncs the log diff, and this same object updates in place.

It also gives you reactive database queries:

```js
const orders = state.order.listRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  skip: 0,
  limit: 50
})

const openOrderCount = state.order.countRef({ status: "open" })
```

`orders` and `openOrderCount` are Vue refs/computed values backed by MongoDB, IndexedDB cache, permissions, and WebSocket sync. Inserts, deletes, and remote updates refresh them automatically.

## Why this exists

Most admin panels need the same chain again and again:

```text
MongoDB -> server API -> WebSocket -> client cache -> Vue state -> page
```

db-state turns that chain into one small library:

- direct reactive access to database documents;
- reactive lists and counters backed by real MongoDB queries;
- automatic sync between browser tabs and users;
- server-side read/write permissions, including field-level rules;
- append-only audit log for every change;
- offline read from IndexedDB cache;
- one WebSocket connection for data RPC and custom app events.

The goal is not to replace MongoDB or Vue state. The goal is to make MongoDB-backed state feel native on a Vue page.

## The core idea

Create one state object:

```ts
import { createDbState } from "@db-state/vue"

type Schema = {
  user: { _id: string; name: string; email: string }
  order: { _id: string; status: string; total: number; createdAt: string }
}

export const state = createDbState<Schema>({
  tables: ["user", "order", "product"],
  wsUrl: "ws://127.0.0.1:8788/db-state/ws"
})
```

Use it directly in pages:

```vue
<script setup>
import { state } from "./state"

const loading = state.getKeyRef("orders")

const orders = state.order.listRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  limit: 50
}, "orders")

const openCount = state.order.countRef({ status: "open" })

async function closeOrder(order) {
  await state.order.update({
    id: order._id,
    set: { status: "closed" }
  })
}
</script>

<template>
  <div v-if="loading > 0">Loading...</div>
  <div>Open orders: {{ openCount }}</div>

  <button
    v-for="order in orders"
    :key="order._id"
    @click="closeOrder(order)"
  >
    {{ order._id }} - {{ order.status }} - {{ order.total }}
  </button>
</template>
```

There is no separate Pinia store, query invalidation layer, manual WebSocket reducer, or per-page loading boilerplate. `listRef`, `countRef`, and `load` share the same reactive objects and cache.

## How sync works

```text
client update()
  -> WebSocket RPC
  -> MongoDB write
  -> append log row
  -> broadcast changes_available
  -> other clients sync(time1)
  -> local reactive objects, lists, counters and IndexedDB cache update
```

Every write creates one immutable log row:

```js
{
  logId,
  createdAt,
  table: "order",
  id: "o1",
  action: "update",       // insert | update | delete
  set: { status: "done" },
  unset: [],
  sessionId,
  userId
}
```

Clients store `time1`, the timestamp of the last fully applied sync. On reconnect or after a notification they ask the server for log rows in `(time1, now]`. The server filters by permissions before returning changes.

## Reactive database API

Each table gets the same methods:

| Client API | Purpose |
|---|---|
| `load(id, key?)` | Returns one reactive document and loads it from cache/server. |
| `getAsync(id, key?)` | One-off async load. |
| `getIds({ filter, sort, skip, limit })` | One-off id query. |
| `idsRef({ filter, sort, skip, limit })` | Reactive cached id list. |
| `listRef({ filter, sort, skip, limit }, key?)` | Reactive computed document list. |
| `countRef(filter)` | Reactive cached counter for a MongoDB filter. |
| `add(obj)` | Inserts a document and applies the returned change locally. |
| `update({ id, set, unset, objedit })` | Patches a document and updates local state/cache. |
| `remove(id)` | Deletes a document and removes it from local state/cache. |
| `getKeyRef(key)` | Tracks loading count for a page/block. |

Important behavior:

- `load(id)` always returns the same reactive object for that table/id.
- `listRef(query)` is `idsRef(query)` plus `load(id)`, so tables and detail panels stay connected.
- `idsRef` and `countRef` are deduplicated. The same query returns the same ref.
- `idsRef` and `countRef` are persisted in IndexedDB, so lists and counters render before the socket reconnects.
- Query refs refresh after login, local writes, and synced table changes.

## Permissions

Access is denied by default. The server checks every RPC:

```text
code rule for table+doc
  -> code rule for table
  -> _permission rules
  -> deny
```

Permission rows live in `_permission`:

```js
{
  _id: "perm_order_manager",
  table: "order",
  priority: 10,
  if: { status: "open" },

  read: {
    groups: ["manager"],
    fields: ["_id", "status", "total"],
    action: true
  },

  write: {
    groups: ["admin"],
    fields: ["status", "comment"],
    action: true
  }
}
```

Field rules are enforced on the server:

- `read.fields` projects `load()`, `getUnique()`, and sync changes.
- `write.fields` validates `add()` and `update()`.
- `write` controls insert, update, and delete.
- Delete log rows store `old`, so audit and permission checks still work after the source document is gone.

For rules that cannot be expressed declaratively, use code access hooks. They can decide from the user/table/log entry or lazily call `ctx.loadDoc()` only when the document is needed.

## Auth and offline read

Users are stored in `_user`:

```js
{
  _id: "u1",
  login: "admin",
  passwordHash: "...",
  hash: "auth-secret",
  groups: ["admin"],
  disabled: false
}
```

The client supports:

```js
await state.login("admin", "password")
await state.authByHash()
await state.logout()
```

Auth hash is stored on the client and reused after page refresh. It is shared per user on the server, so opening another tab does not invalidate existing sessions. Rotate `_user.hash` if you need to force logout everywhere.

Default client storage:

| Data | Storage |
|---|---|
| Documents | IndexedDB |
| `idsRef` / `countRef` values | IndexedDB |
| `time1` sync cursor | `localStorage` |
| `userId` / auth hash | `localStorage` |
| `sessionId` | `sessionStorage` |

Offline writes are intentionally not queued. If the socket is offline, writes fail instead of creating conflict resolution work later. Cached reads keep working.

## Server setup

```ts
import { WebSocketServer } from "ws"
import { MongoClient } from "mongodb"
import { createDbStateServer } from "@db-state/server-mongo"

const mongo = (await new MongoClient(process.env.MONGO_URI).connect()).db("app")

const dbState = createDbStateServer({
  mongo,
  tables: ["user", "order", "product"]
})

new WebSocketServer({ port: 8788, path: "/db-state/ws" })
  .on("connection", (ws) => dbState.socket.addClient(ws))
```

Recommended MongoDB indexes:

```js
await mongo.collection("log").createIndex({ createdAt: 1, logId: 1 })
await mongo.collection("_permission").createIndex({ table: 1, priority: -1 })
await mongo.collection("order").createIndex({ status: 1, createdAt: -1 })
```

## Packages

| Package | Size | Purpose |
|---|---:|---|
| [`@db-state/core`](packages/core) | ~1.5 KB min+gz | Shared protocol, `Change`, dot-path helpers, sync-window helpers. Zero runtime deps. |
| [`@db-state/vue`](packages/vue) | ~5 KB min+gz | Vue 3 reactive client: documents, lists, counters, auth, cache, WebSocket sync. |
| [`@db-state/server-mongo`](packages/server-mongo) | ~5 KB min+gz | MongoDB WebSocket server: CRUD, auth, log, sync, permissions, audit. |

## Install

```sh
npm install @db-state/vue @db-state/server-mongo
```

`@db-state/core` is installed automatically as a dependency.

## Demos

```sh
npm install

npm run demo:server
npm run demo:client
npm run demo:smoke

npm run demo2:server
npm run demo2:client
npm run demo2:smoke
```

- `demo/` - minimal Vue page with an in-memory Mongo-like server.
- `demo2/` - full admin console for orders, users, groups, permissions, real MongoDB, and offline PWA shell.

Default demo users:

```text
admin / admin
manager / manager
viewer / viewer    // demo2
```

## Documentation

- [Full documentation](docs/en/README.md)
- [Reactive queries](docs/en/client/reactive-queries.md)
- [Permissions](docs/en/server/permissions.md)
- [Sync protocol](docs/en/architecture/sync-protocol.md)
- [Admin panel cookbook](docs/en/cookbook/admin-panel.md)
- [Changelog](CHANGELOG.md)

## Project status

Early release, `0.0.x`. The API is intentionally small, but still pre-1.0. See [CHANGELOG.md](CHANGELOG.md) for release notes and current limitations.

License: MIT.
