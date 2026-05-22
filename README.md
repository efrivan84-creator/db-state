# db-state

> **English** · [Русский](README.ru.md)

[![npm @db-state/vue](https://img.shields.io/npm/v/@db-state/vue?label=%40db-state%2Fvue)](https://www.npmjs.com/package/@db-state/vue)
[![npm @db-state/server-mongo](https://img.shields.io/npm/v/@db-state/server-mongo?label=%40db-state%2Fserver-mongo)](https://www.npmjs.com/package/@db-state/server-mongo)
[![license](https://img.shields.io/npm/l/@db-state/vue)](LICENSE)

Tiny realtime reactive state layer for Vue 3 + MongoDB. WebSocket sync, declarative permissions, offline cache, full TypeScript support — all in roughly **4 KB brotli** on the client.

## Packages

| Package | Size (min+gz) | What it does |
|---|---:|---|
| [`@db-state/core`](packages/core) | ~1.5 KB | Shared protocol, `Change`, dot-path helpers. Zero deps. |
| [`@db-state/vue`](packages/vue) | ~5 KB | Vue 3 client: reactive `listRef`/`idsRef`/`countRef`, CRUD, login, IndexedDB cache, auto-sync over WebSocket. |
| [`@db-state/server-mongo`](packages/server-mongo) | ~5 KB | Mongo-backed server: CRUD, append-only log, sync, WebSocket RPC, field-level permissions. |

## Quickstart

```sh
npm install @db-state/vue @db-state/server-mongo
```

**Client** (Vue 3):

```ts
import { createDbState } from "@db-state/vue"

type Schema = {
  order: { _id: string; status: "open" | "closed"; total: number }
}

export const state = createDbState<Schema>({ tables: ["order"] })

// In a component:
const open = state.order.listRef({ filter: { status: "open" }, sort: { total: -1 } })
await state.order.update({ id: "o1", set: { status: "closed" } })
```

**Server** (Node + Mongo + `ws`):

```ts
import { WebSocketServer } from "ws"
import { MongoClient } from "mongodb"
import { createDbStateServer } from "@db-state/server-mongo"

const mongo = (await new MongoClient(process.env.MONGO_URI).connect()).db("app")
const dbState = createDbStateServer({ mongo, tables: ["order"] })

new WebSocketServer({ port: 8788, path: "/db-state/ws" })
  .on("connection", (ws) => dbState.socket.addClient(ws))
```

## Demos

Two demos live in this repo. **Both consume the published `@db-state/*` packages** — same imports any external user would write. During local development this monorepo wires those names to `packages/*` via npm workspaces (symlinks), so editing source updates the demos instantly.

### `demo/` — minimal example with in-memory Mongo

The simplest possible setup: server runs in Node with an in-memory Mongo-like store ([demo/server/memoryMongo.js](demo/server/memoryMongo.js)), client is a single Vue page that loads one order and shows field-level permission denial. No external services required.

Showcases:
- `state.order.load(id)` with reactive `__loaded` flag and loading-key tracking
- field-level permissions: `manager` can edit `status`/`comment` but not `margin`
- end-to-end smoke test ([demo/smoke.js](demo/smoke.js)) spinning up the real server and driving it over WebSocket

```sh
npm install
npm run demo:server     # terminal 1 — WebSocket server on :8787
npm run demo:client     # terminal 2 — Vite dev server on http://127.0.0.1:5173
npm run demo:smoke      # one-shot end-to-end test (no client needed)
```

Default users: `admin / admin`, `manager / manager` (passwords are obviously demo-only).

### `demo2/` — full admin console with real MongoDB

A 4-tab admin panel ([demo2/client](demo2/client)) that lets you CRUD orders, users, groups and permissions live. Demonstrates the complete library on a real MongoDB:

- typed reactive tables (`order`, `_user`, `_group`, `_permission`)
- realtime cross-tab updates: open two browser tabs, edit in one, see the form fields update in the other instantly
- diff-based saves: only changed fields go over the wire (no field-level conflicts between concurrent editors)
- role switching: `admin` sees everything, `manager` sees orders without `margin` and can only edit `status`/`comment`, `viewer` is read-only with a narrow field projection
- popover-style delete confirmation
- raw JSON editor for `_permission` rules with auto-generated `_id`
- offline PWA via service worker ([demo2/client/public/db-state-offline-sw.js](demo2/client/public/db-state-offline-sw.js))

Requires a running MongoDB. Defaults to `mongodb://localhost:27017`; override with env vars — see [`.env.example`](.env.example) for the full list.

```sh
npm install
# point at your mongo (optional — without it uses localhost:27017)
export DB_STATE_MONGO_URI="mongodb://user:pass@host:27017/?authSource=admin"

npm run demo2:server    # terminal 1 — WebSocket server on :8788
npm run demo2:client    # terminal 2 — Vite dev server on http://127.0.0.1:5174
npm run demo2:smoke     # one-shot end-to-end test
```

Default users: `admin / admin`, `manager / manager`, `viewer / viewer`.

### How the demos resolve `@db-state/*` locally

Each demo imports the library by its public package name:

```js
// demo2/client/src/state.js
import { createDbState } from "@db-state/vue"

// demo2/server/index.js
import { createDbStateServer } from "@db-state/server-mongo"
```

The root [`package.json`](package.json) declares `@db-state/core`, `@db-state/vue` and `@db-state/server-mongo` as dependencies with `"*"` version, and lists `packages/*` under `workspaces`. On `npm install`, npm sees both — and creates symlinks `node_modules/@db-state/{core,vue,server-mongo}` → `packages/{core,vue,server-mongo}`. Vite and Node resolve the imports through those symlinks. Result: demo code looks exactly like consumer code, but every edit in `packages/*` is reflected immediately without `npm publish`.

## Client

```js
import { createDbState } from "@db-state/vue"

export const state = createDbState(["user", "order", "product"])
```

The service tables `_user`, `_group`, and `_permission` are added automatically on both client and server, but they still require normal read/write permissions.

Page code:

```js
const progress = state.getKeyRef("profile")
const user = state.user.load(userId, "profile")
const orders = state.order.listRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  skip: 0,
  limit: 50
}, "orders")
const openOrderIds = state.order.idsRef({ filter: { status: "open" } })
const openOrderCount = state.order.countRef({ status: "open" })

await state.user.update({
  id: userId,
  objedit: {
    fio: user.fio
  }
})
```

Reactive query helpers:

- `load(id, key)` returns one reactive document and loads it from cache/server when needed.
- `idsRef({ filter, sort, skip, limit })` returns a Vue `ref` with matching ids.
- `listRef({ filter, sort, skip, limit }, key)` returns a Vue `computed` list of documents by combining `idsRef` with `load(id, key)`.
- `countRef(filter)` returns a Vue `ref` with the server count for that filter.

`idsRef` and `countRef` are deduplicated per table. Calling them again with the same settings returns the existing ref instead of creating another server refresh loop. Object key order does not matter.

`countRef` and `idsRef` are persisted in the client cache. When a ref is created it first reads the last cached value from IndexedDB/cache and does not immediately call the server. Server refresh happens after manual login and after table changes received through sync or local writes. Hash auth/page refresh does not refresh query refs by itself. Fresh server values are written back to the cache.

Custom socket events are available. `dbstate:*` events are reserved for the library.

```js
state.socket.on("auth:expired", refreshToken)
state.socket.send("client:ready", { page: "profile" })
```

Default client storage:

- `sessionStorage` for `sessionId`;
- `localStorage` for `time1`;
- `localStorage` for auth `userId/hash`;
- IndexedDB for entity cache, with memory fallback outside the browser.

Auto-auth is enabled by default. On WebSocket reconnect or page refresh the client reads saved `userId/hash`, calls `authByHash`, then runs sync. It does not refresh `countRef`/`idsRef` unless sync returns table changes.

```js
export const state = createDbState({
  tables: ["user", "order", "product"],
  autoAuth: true
})
```

If the saved hash is rejected, the client clears the saved auth data and returns to anonymous state.

## Server

```js
import { createDbStateServer } from "@db-state/server-mongo"

const dbState = createDbStateServer({
  mongo,
  tables: ["user", "order", "product"]
})
```

Users live in `_user` and authenticate over WebSocket:

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

The auth `hash` is shared for the user and reused across logins. Opening another tab does not rotate it and does not invalidate existing tabs. To logout every device, rotate `_user.hash` on the server.

Client API:

```js
await state.login("ivan", "password")
await state.authByHash()
await state.logout()
```

WebSocket is the only transport. Attach clients from your `ws`/framework adapter:

```js
dbState.socket.addClient(ws, {
  user: {
    _id: userId,
    groups: ["manager"]
  },
  sessionId
})
```

Access is denied by default. The server checks:

```text
code rule for table+doc -> code rule for table -> _permission rules -> deny
```

Permission documents live in `_permission`:

```js
{
  table: "order",
  priority: 10,
  if: { status: "open" },
  read: { groups: ["manager"], action: true, fields: ["_id", "status", "total"] },
  write: { groups: ["admin"], action: true, fields: ["status", "comment"] }
}
```

`fields` is optional. When present, reads and returned sync changes are projected to those fields, and `add/update` reject forbidden write fields. `remove` still uses document-level `write`.

Incoming library messages use RPC over the same socket:

```js
{
  type: "dbstate:rpc",
  id: "rpc1",
  method: "update",
  payload: { table: "user", id: "u1", set: { fio: "Ivan" } }
}
```

The server replies:

```js
{
  type: "dbstate:rpc_result",
  id: "rpc1",
  result: { ok: true, change }
}
```

Main flow:

```text
client WS RPC update -> MongoDB -> log -> WebSocket changes_available -> clients WS RPC sync(time1)
```

Each log entry stores `userId`. Delete entries also store `old`, the deleted document, so sync permissions and audit still work after the source document is gone.

`sync` selects:

```js
createdAt > time1 && createdAt <= time2 && sessionId != currentSessionId
```

The client moves `time1` only after all returned changes are applied and cached.

For sync permissions, Mongo documents are loaded only when needed. Rules without `_permission.if` are checked from the log entry plus `table/user/groups`; rules with `if` load the current document. Code access rules can call `ctx.loadDoc()` to load the document lazily.

## Status

Early release (`0.0.x`). API is small and stable in shape, but treat as pre-1.0:

- Realtime CRUD with permissions, offline cache, login, sync — done and tested (38 tests).
- TypeScript declarations — done, full generic schema typing.
- Append-only log gives you audit trail and time-travel rollback for free.
- Permission `if`-condition DSL currently supports equality only — operators like `$in`, `$gte` are on the roadmap.
- `broadcast` fans out a `changes_available` ping to all clients on every write; for >1000 concurrent clients this will need per-client filtering (not yet implemented).
- Vue + Mongo + WebSocket only — no React/Postgres/etc adapters.

PRs welcome. License: MIT.
