# Getting started

This guide takes you from zero to a working realtime CRUD page in about five minutes.

## What you'll build

A Vue 3 page that lists open orders, lets you close one, and **updates live in every browser tab** as soon as anyone closes an order — including those changes coming from other tabs of your own.

## Prerequisites

- Node 18 or newer.
- A MongoDB instance reachable from your server (for the trivial demo path, you can use `mongodb://localhost:27017`; an in-memory mock also works — see the [demo](../../demo) folder).
- A Vue 3 app (Vite recommended). Any setup that supports ES modules and Vite/webpack/esbuild bundler with tree-shaking will do.

## Install

```sh
# In your Vue app
npm install @db-state/vue

# In your Node server
npm install @db-state/server-mongo mongodb ws
```

`@db-state/core` is pulled in transitively by both packages — you don't install it directly.

## Server (Node)

`server.js`:

```js
import { WebSocketServer } from "ws"
import { MongoClient } from "mongodb"
import { createDbStateServer } from "@db-state/server-mongo"

// 1. Connect to Mongo.
const client = await new MongoClient(
  process.env.MONGO_URI ?? "mongodb://localhost:27017"
).connect()
const mongo = client.db("myapp")

// 2. Seed at least one user so the client can log in.
await mongo.collection("_user").updateOne(
  { _id: "u_admin" },
  {
    $setOnInsert: {
      _id: "u_admin",
      login: "admin",
      passwordHash: "$pbkdf2$...",  // see "Authentication" docs for password adapters
      groups: ["admin"]
    }
  },
  { upsert: true }
)

// 3. Seed at least one permission so the client can read/write.
await mongo.collection("_permission").updateOne(
  { _id: "perm_order_admin" },
  {
    $setOnInsert: {
      _id: "perm_order_admin",
      table: "order",
      priority: 100,
      read:  { groups: ["admin"] },
      write: { groups: ["admin"] }
    }
  },
  { upsert: true }
)

// 4. Create the db-state server.
const dbState = createDbStateServer({
  mongo,
  tables: ["order"]
})

// 5. Attach a WebSocket server.
new WebSocketServer({ port: 8788, path: "/db-state/ws" })
  .on("connection", (ws) => dbState.socket.addClient(ws))

console.log("db-state server on ws://localhost:8788/db-state/ws")
```

Run it: `node server.js`.

> **Permissions are deny-by-default.** Without the `_permission` row above, no client can read or write `order`. See [Permissions](server/permissions.md) for the full model.

> **Passwords**: in production use the bundled PBKDF2 adapter via `defaultPassword.hash(...)`. For local demos, you can plug in a trivial adapter (`hash: p => "demo:" + p, verify: (p, h) => h === "demo:" + p`) — see [Authentication](server/authentication.md).

## Client (Vue 3)

`src/state.js`:

```js
import { createDbState } from "@db-state/vue"

export const state = createDbState({
  tables: ["order"],
  wsUrl: "ws://localhost:8788/db-state/ws"
})
```

`src/components/Orders.vue`:

```vue
<script setup>
import { state } from "../state.js"

// Log in once (in a real app, you'd have a Login form):
state.login("admin", "admin")

// Reactive query — re-renders automatically when the server pushes changes.
const orders = state.order.listRef({
  filter: { status: "open" },
  sort: { createdAt: -1 }
})

async function close(id) {
  await state.order.update({ id, set: { status: "closed" } })
}

async function add() {
  await state.order.add({
    _id: `o_${crypto.randomUUID()}`,
    status: "open",
    total: Math.round(Math.random() * 1000),
    createdAt: new Date().toISOString()
  })
}
</script>

<template>
  <button @click="add">+ New order</button>
  <ul>
    <li v-for="o in orders" :key="o._id">
      {{ o.total }} ₽ — {{ o.status }}
      <button @click="close(o._id)">Close</button>
    </li>
  </ul>
</template>
```

That's it. Run your Vue app and the server. Open **two browser tabs** — adding or closing an order in one tab updates the list in the other tab in real time, with no polling, no manual `addEventListener`, no manual cache invalidation.

## What you get out of the box

Without writing any extra code, you now have:

| Feature | How it works |
|---|---|
| **Realtime cross-tab sync** | Server broadcasts `changes_available`; clients pull the diff over WebSocket. |
| **Offline read** | First load is from IndexedDB cache; server refresh happens after reconnect/login. |
| **Per-field permissions** | Add `fields: ["status", "total"]` to the `_permission` rule — server projects reads and rejects forbidden writes. |
| **Audit trail** | Every change is in the `log` collection with `userId`, `set`, `unset`, full `old` document on delete. |
| **Time-travel** | Replay `log` entries by `createdAt` to reconstruct any document at any point in time. |
| **Auto reconnect** | Client retries the WebSocket with backoff; on success it calls `authByHash` and resyncs from the last `time1`. |

## Next steps

- Type your schema with TypeScript: [client/typescript.md](client/typescript.md).
- Dig into permissions: [server/permissions.md](server/permissions.md).
- See the full [demo2](../../demo2) admin panel for a real-world example with users, groups, permissions and live multi-tab editing.
- Read [architecture/how-it-works.md](architecture/how-it-works.md) to understand the sync protocol.
