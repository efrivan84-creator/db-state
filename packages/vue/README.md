# @db-state/vue

> **English** · [Русский](README.ru.md)

Tiny reactive Vue 3 client for [db-state](https://github.com/efrivan84-creator/db-state): typed tables, `listRef` / `idsRef` / `countRef`, login, sync, offline cache. Around **5.4 KB brotli** / **6.0 KB min+gz**.

It creates a global reactive state object backed by WebSocket RPC, local cache, and server sync.

## What you get

- A tiny global Vue store that mirrors MongoDB tables through db-state RPC.
- Direct page API: `state.order.load(id).status`, `state.order.update(...)`, `state.order.listRef(...)`.
- Reactive query refs: `idsRef`, `listRef`, and `countRef` with `filter`, `sort`, `skip`, and `limit`.
- Query deduplication: the same query returns the same ref instead of creating another refresh loop.
- Cache-first query refs: cached ids/counts render immediately from IndexedDB, then refresh after login or synced changes for their table.
- Offline-read behavior for documents, ids, counts, auth hash, and `time1`.
- Loading groups via `getKeyRef(key)` for page-level skeletons/progress.
- WebSocket RPC, reconnect, `login`, `authByHash`, `logout`, and custom app events on the same socket.
- TypeScript generics for table names, filters, sort keys, document fields, and update payloads.

## Install

```sh
npm install @db-state/vue
```

`vue` (>=3.0.0) is a peer dependency.

## Setup

```js
import { createDbState } from "@db-state/vue"

export const state = createDbState(["user", "order", "product"])
```

Use this as a singleton. One app should normally have one `state` instance.

### TypeScript

Provide a schema generic — every table accessor is then typed against it, including filters, sort keys, update fields and load results:

```ts
import { createDbState } from "@db-state/vue"

type Schema = {
  user:  { _id: string; login: string; fio?: string }
  order: { _id: string; status: "open" | "closed"; total: number; createdAt: string }
}

export const state = createDbState<Schema>({
  tables: ["user", "order"],
  wsUrl: "wss://example.com/db-state/ws"
})

const open = state.order.listRef({ filter: { status: "open" }, sort: { createdAt: -1 } })
//    ^ ComputedRef<ReactiveDoc<Order>[]>

await state.order.update({ id: "o1", set: { status: "closed" } })
//                                          ^ "open" | "closed" — typed
```

Service tables (`_user`, `_group`, `_permission`) are typed automatically with sensible defaults and can be overridden in the schema.

`_user`, `_group`, and `_permission` are added automatically:

```js
state._user.load(userId)
state._group.getIds()
state._permission.getIds()
```

The server still decides access through the normal permission rules.

## Page Usage

The main pattern is direct reactive document access:

```js
state.user.load(userId, "profile").profile.name
state.user.load(userId, "profile").profile.phone
state.user.load(userId, "profile").settings.theme
```

For one table/id pair, `load(id, key)` returns the same reactive object everywhere. The first call starts one cache/server load; later calls reuse the object and do not duplicate requests. When sync receives a server change, the object is patched in place and every component using it updates automatically. The `key` groups those reads, and optional mutation keys, into one page/form loading progress state.

```js
const progress = state.getKeyRef("profile")
const user = state.user.load(userId, "profile")
const orders = state.order.listRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  skip: 0,
  limit: 50
}, "orders")
const openOrderCount = state.order.countRef({ status: "open" })

await state.user.update({
  id: userId,
  objedit: {
    fio: user.fio
  }
}, "profile")

// progress.value   active operations
// progress.max     peak active operations in the current wave
// progress.start   false until the first operation starts
// progress.percent active operations left: progress.value / progress.max * 100
// use 100 - progress.percent for a filling progress bar
```

Use the same key for reads and writes when one page needs a single progress state. For example, `load` / `listRef` can show page loading progress, and `add` / `update` / `remove` can show the progress of submitted changes.

## Table API

Each table gets the same methods:

```js
state.user.load(id, key)
state.user.getAsync(id, key)
state.user.getIds(query, key)
state.user.getUnique(query, key)
state.user.countRef(filter)
state.user.idsRef(query)
state.user.listRef(query, key)
state.user.update({ id, objedit }, key)
state.user.add(obj, key)
state.user.remove(id, key)
state.user.onChange((change) => {})
state.user.onAdd((obj, change) => {})
state.user.onEdit((obj, change) => {})
state.user.onDelete((oldObj, change) => {})
state.user.isLoading(id)
state.user.getError(id)
```

### Method summary

| Method | What it returns / does |
|---|---|
| `load(id, key?)` | Returns one reactive document and loads it from cache/server if needed. |
| `getAsync(id, key?)` | One-off async document load. |
| `getIds(query, key?)` | One-off id query with `filter`, `sort`, `skip`, `limit`. |
| `getUnique(query, key?)` | One-off unique-field query. |
| `add(obj, key?)` | Creates a document, tracks optional loading key, and applies the returned change locally. |
| `update({ id, set, unset, objedit }, key?)` | Patches a document, tracks optional loading key, and updates local state/cache on success. |
| `remove(id, key?)` | Deletes a document, tracks optional loading key, and removes it from local state/cache. |
| `countRef(filter)` | Reactive cached count for a filter. |
| `idsRef(query)` | Reactive cached id list for a query. |
| `listRef(query, key?)` | Computed list: `idsRef(query)` + `load(id, key)`. |
| `onChange(fn)` | Table-level hook for every applied change. |
| `onAdd(fn)` / `onEdit(fn)` / `onDelete(fn)` | Table-level hooks for inserts, updates, and deletes. |
| `isLoading(id)` / `getError(id)` | Per-document request state. |

Reactive reads (`load`, `idsRef`, `listRef`, `countRef`) are cache-first. They do not call protected server RPCs until `state.auth.status === "authorized"`. If they miss the cache while auth/socket is not ready, they keep their loaded marker false and are retried after authorization.

One-off reads (`getAsync`, `getIds`, `getUnique`) wait for authorization because their result cannot update later. Prefer the reactive APIs for UI. Writes (`add`, `update`, `remove`) wait up to `writeAuthTimeout` (default 3000 ms) for authorization, then throw if the socket is still not authorized.

### Change Hooks

Hooks run after `applyChange()` updates the reactive table and cache. They fire for local mutation responses and for remote sync changes.

```js
const offAll = state.onChange((change) => {
  console.log(change.table, change.action, change.id)
})

const offOrderEdit = state.order.onEdit((order, change) => {
  if (order) console.log(order.status)
})

state.order.onAdd((order, change) => {})
state.order.onDelete((oldOrder, change) => {})

offAll()
offOrderEdit()
```

`onEdit` receives `undefined` when an update arrives for a document that was never loaded locally. `onDelete` receives `change.old` when the server sent it, otherwise the previously loaded local object.

### Reactive Queries

`countRef(filter)` returns a Vue `ref` with the server count for a filter:

```js
const openCount = state.order.countRef({ status: "open" })
```

When the ref is created, it first reads the last cached value from IndexedDB/cache and does not immediately call the server. The count is refreshed after manual login, after local writes, and when sync applies changes for the same table. Hash auth itself does not refresh every cached count. The refreshed value is saved back to cache. If the same `countRef` is requested again for the same table and filter, the existing ref is returned.

`idsRef(query)` returns a Vue `ref` with ids matching a server query:

```js
const orderIds = state.order.idsRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  skip: 0,
  limit: 50
})
```

The query object is passed to the server as `{ table, ...query }`, so `filter`, `sort`, `skip`, and `limit` are supported by the same API. When the ref is created, it first reads the last cached ids from IndexedDB/cache and does not immediately call the server. The ids ref is refreshed after manual login, after local writes, and when sync applies changes for the same table. Hash auth itself does not refresh every cached ids ref. The refreshed value is saved back to cache. If the same query is requested again for the same table, the existing ref is returned.

`listRef(query, key)` is the page-level helper for lists:

```js
const orders = state.order.listRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  skip: 0,
  limit: 50
}, "orders")
```

Internally it is only `idsRef(query)` plus `load(id, key)`:

```js
computed(() => ids.value.map((id) => state.order.load(id, key)))
```

It does not keep a second object cache. The id list, document loading, sync updates, and IndexedDB cache stay separate.

Creation is cache-first:

```text
countRef/idsRef created -> read cached value -> wait for login, missing cache, or table change -> refresh from server -> save cache
```

`countRef` and `idsRef` use a stable key built from the settings object. Object key order does not matter:

```js
state.order.idsRef({ filter: { status: "open" }, limit: 10 })
state.order.idsRef({ limit: 10, filter: { status: "open" } })
// same ref
```

## WebSocket

The library uses WebSocket as the only transport.

System events use `dbstate:*` and are reserved.

Custom app events are allowed:

```js
state.socket.on("auth:expired", refreshToken)
state.socket.send("client:ready", { page: "orders" })
```

## Auth

Login:

```js
await state.login("ivan", "password")
```

The server returns `userId` and `hash`. The client clears local cache/in-memory tables, sets `time1` to the current login moment, stores credentials in `localStorage`, and retries active reactive reads. `login()` does not run `syncNow()`.

Reconnect with saved credentials:

```js
await state.authByHash()
```

Auto-auth is enabled by default:

```js
export const state = createDbState({
  tables: ["user", "order", "product"],
  autoAuth: true
})
```

When the socket opens after a page refresh, the client reads saved `userId/hash`, calls `authByHash`, runs sync, and retries reactive documents or query refs that missed cache/auth. Cached query refs still render immediately from IndexedDB. They are refreshed only when sync applies changes for their table. If the server rejects the saved hash, the client clears saved auth data and switches back to anonymous state.

You can call the same flow manually:

```js
const ok = await state.autoAuth()
```

Logout on this device:

```js
await state.logout()
```

Logout only forgets the local `hash`. To logout every device, rotate `_user.hash` on the server.

## Offline Read

The Vue client can read cached data while offline:

- documents are loaded from IndexedDB/cache through `load(id)`;
- `countRef` and `idsRef` read their last cached values first;
- saved `userId/hash` starts the client in `restored` status, so a refreshed page can keep showing cached data before the socket is available;
- when the socket reconnects, `authByHash` verifies the saved hash and `sync` applies any log changes.

The application shell itself must be cached by the host app, usually with a service worker. The demo2 app registers `db-state-offline-sw.js` for this.

## Storage

Defaults:

- `sessionStorage` stores `sessionId`;
- `localStorage` stores `time1`;
- `localStorage` stores auth `userId/hash`;
- IndexedDB stores cached records and cached `idsRef`/`countRef` values;
- memory cache is used when IndexedDB is unavailable.

Cache adapters:

```js
import {
  createIndexedDbCache,
  createMemoryCache,
  createStorageCache
} from "@db-state/vue"
```

## Useful links

- Full docs: [docs/en](../../docs/en/README.md)
- Reactive queries: [docs/en/client/reactive-queries.md](../../docs/en/client/reactive-queries.md)
- Cache/offline: [docs/en/client/cache-and-offline.md](../../docs/en/client/cache-and-offline.md)
- Admin panel cookbook: [docs/en/cookbook/admin-panel.md](../../docs/en/cookbook/admin-panel.md)

## Internal Files

- `index.js` - `createDbState`, global state and sync loop.
- `table.js` - table methods.
- `socket.js` - WebSocket RPC.
- `cache.js` - cache adapters.
- `keys.js` - progress key tracking.
- `storage.js` - session and storage helpers.
