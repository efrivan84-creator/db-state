# Cache and offline

The Vue client maintains a persistent **record cache** and several **storage facets**. Together they let you show useful data on cold start, on page refresh, and when the server is unreachable.

## What is cached and where

| Data | Default backend | Purpose |
|---|---|---|
| Individual documents | IndexedDB | Cold-start `load(id)` returns immediately. |
| `idsRef` / `countRef` last values | IndexedDB (table `__dbstate_query`) | Lists and counts show previous values before server refresh. |
| `time1` (sync cursor) | localStorage | Skip already-applied changes on reconnect. |
| Session id | sessionStorage | Per-tab id for echo-filtering during sync. |
| `userId` / auth hash | localStorage | Restore auth without re-asking for password. |

The reactive in-memory store (`state.order.items`) is **not** persisted — it's reconstructed from the cache + sync on page load.

## Cache backends

Three are bundled. Pass via the `cache` option to `createDbState`.

### `createIndexedDbCache(options?)` — default

```js
import { createIndexedDbCache, createDbState } from "@db-state/vue"

const state = createDbState({
  tables: ["order"],
  cache: createIndexedDbCache({
    name: "myapp",     // IndexedDB database name (default: "db-state")
    store: "records"   // object store name (default: "records")
  })
})
```

Pros: unlimited size in practice, async non-blocking, persists across sessions.
Cons: only in browsers (falls back to memory in Node).

### `createStorageCache(options?)`

```js
import { createStorageCache } from "@db-state/vue"

createDbState({
  tables: ["order"],
  cache: createStorageCache({
    storage: localStorage,   // any { getItem, setItem, removeItem }
    key: "myapp.cache"        // single key, JSON-encoded
  })
})
```

Pros: works synchronously, easy to inspect, easy to clear in dev tools.
Cons: ~5 MB hard limit (browsers), full JSON re-serialization on every write. Use for very small datasets only.

### `createMemoryCache()`

```js
import { createMemoryCache } from "@db-state/vue"

createDbState({
  tables: ["order"],
  cache: createMemoryCache()
})
```

Pros: no persistence — useful for SSR, tests, demos.
Cons: gone on page refresh.

### Custom backend

Implement the `DbStateCache` interface:

```ts
interface DbStateCache {
  get<T>(table: string, id: string): Promise<T | undefined>
  set<T>(table: string, id: string, value: T): Promise<void>
  delete(table: string, id: string): Promise<void>
  clear(): Promise<void>
}
```

Useful for: encrypted cache (wrap IndexedDB with crypto), shared cache via SharedWorker, server-side persistent stores.

## Initialization order on page load

```text
1. createDbState() instantiates reactive store (empty)
2. Reads saved sessionId, time1, userId, authHash from storage
3. Opens WebSocket (if autoConnect=true)
4. Component renders — calls state.order.load(id)
   → cache.get("order", id) hits IndexedDB → reactive doc populated immediately
5. WebSocket opens → onConnect → autoAuth() (if userId+hash saved)
6. autoAuth succeeds → syncNow() → applies diff since time1
7. Cache and reactive store updated with diff
```

Steps 4 and 5 happen in parallel, so the UI shows cached data before authentication completes. This is what enables `state.auth.status === "restored"` — the page is interactive while we wait for the socket.

## Patterns

### Show cached UI before auth completes

```vue
<script setup>
import { state } from "./state"
const order = state.order.load("o1")
</script>

<template>
  <div v-if="state.auth.status === 'restored'" class="banner">
    Showing cached data, reconnecting...
  </div>
  <article v-if="order.__loaded">
    {{ order.status }} — {{ order.total }}
  </article>
</template>
```

The order shows from IndexedDB cache. Once `syncNow` finishes, it may update silently (or visibly) with fresh data.

### Cache-busting after a deploy

Add a version prefix to the IndexedDB name:

```js
const APP_VERSION = "2026-05-22"

createDbState({
  tables: ["order"],
  cache: createIndexedDbCache({ name: `myapp-${APP_VERSION}` })
})
```

Old IndexedDB databases stay around (browsers don't auto-clean them), but your new release reads from a fresh one. After a few releases, optionally clean up old ones:

```js
const dbs = await indexedDB.databases()
for (const { name } of dbs) {
  if (name?.startsWith("myapp-") && name !== `myapp-${APP_VERSION}`) {
    indexedDB.deleteDatabase(name)
  }
}
```

### Clear cache on logout

By default, `state.logout()` keeps the cache (so anonymous-allowed reads work). For shared-device safety:

```js
async function fullLogout() {
  await state.logout()
  await state.clearLocalDB()  // wipes cache, in-memory tables, time1, session
}
```

### Offline writes — not supported

The library **does not queue writes for later replay**. If you call `update()` while offline, it'll throw a timeout. You can:

1. Show a "you're offline" indicator (`state.sync.connected === false`).
2. Disable Save buttons.
3. Or queue manually using IndexedDB and replay on reconnect in your application code.

True offline-write CRDT replication is not the library's design goal — that's [Yjs](https://yjs.dev) territory.

### Service Worker integration

The demo2 app registers a service worker that caches the application shell (HTML, JS, CSS) — see [demo2/client/public/db-state-offline-sw.js](../../../demo2/client/public/db-state-offline-sw.js). Combine that with db-state's IndexedDB cache and you get a fully offline-read PWA.

Full walkthrough: [cookbook/offline-pwa.md](../cookbook/offline-pwa.md).

## Sizing

A typical document of 1 KB JSON consumes ~1.5 KB in IndexedDB (overhead). For 100k docs that's about 150 MB — well within browser quotas (Chrome: ~60% of free disk, Firefox: 50% of free disk per origin).

For very large datasets:

- Don't `load(id)` documents you won't show. Use `idsRef` + `listRef` with `limit`, and load only what's visible.
- Periodically clear stale entries via `cache.delete(table, id)` if you keep navigating to new docs and old ones become irrelevant.

## When NOT to cache

If your documents contain very sensitive data (e.g. PII, financial records) and the device is shared, consider:

- Using `createMemoryCache()` — no persistence at all.
- Or using `createStorageCache({ storage: sessionStorage })` — gone when the tab closes.
- Or wrapping IndexedDB with encryption (custom backend).

The default `createIndexedDbCache` is **not encrypted**. Anyone with file-system access to the browser profile can read the stored documents.
