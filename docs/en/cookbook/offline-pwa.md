# Cookbook: offline PWA

db-state already caches documents, `idsRef`, and `countRef` in IndexedDB. To make a Vue app usable offline, add a service worker for the application shell and design writes to require an online socket.

## What works offline

Out of the box, the Vue client can read cached data offline:

- `state.table.load(id)` reads the cached document first;
- `idsRef(query)` reads cached ids first;
- `countRef(filter)` reads cached counts first;
- saved `userId/hash` starts the client in `restored` status before the socket verifies auth;
- after reconnect, `authByHash()` verifies the hash and `syncNow()` catches up.

Writes are online-only:

```js
await state.order.update({ id, set })
```

This sends WebSocket RPC to the server. If the socket is offline, the write should fail instead of being queued. That avoids conflict resolution complexity.

## Client setup

```js
import { createDbState } from "@db-state/vue"

export const state = createDbState({
  tables: ["order"],
  wsUrl: "wss://example.com/db-state/ws",
  autoAuth: true
})
```

Default storage:

- `sessionStorage`: per-tab `sessionId`;
- `localStorage`: `time1`, `userId`, `hash`;
- IndexedDB: documents and query refs.

## Register a service worker

```js
// main.js
import { createApp } from "vue"
import App from "./App.vue"

createApp(App).mount("#app")

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/db-state-offline-sw.js")
}
```

## Service worker

This strategy is cache-first, but gives the network a short chance to win. In development, `80ms` keeps pages fresh when the network is fast. In production you can set it to `0` for a stricter cache-first shell.

```js
const CACHE_NAME = "my-admin-v1"
const NETWORK_GRACE_MS = 80
const SHELL = ["/", "/index.html"]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
  )
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  const url = new URL(request.url)

  if (request.method !== "GET") return
  if (url.origin !== location.origin) return
  if (url.search) return
  if (url.pathname.includes("-noCache")) return

  event.respondWith(cacheFirstWithNetworkGrace(request))
})

async function cacheFirstWithNetworkGrace(request) {
  const cache = await caches.open(CACHE_NAME)
  let response

  const cached = cache.match(request).then((hit) => {
    if (hit) response = hit
  })

  const network = fetch(request.clone())
    .then((fresh) => {
      response = fresh
      if (fresh.status < 400) cache.put(request, fresh.clone())
    })
    .catch(() => {})

  await Promise.race([cached, network])
  await Promise.race([
    new Promise((resolve) => setTimeout(resolve, NETWORK_GRACE_MS)),
    network
  ])

  if (response) return response

  await cached
  await network
  if (response) return response

  if (request.mode === "navigate") {
    return cache.match("/index.html")
  }

  return new Response("Offline", { status: 503 })
}
```

## Offline UI state

Use the built-in status:

```js
const canWrite = computed(() =>
  state.sync.connected && state.auth.status === "authorized"
)

const statusText = computed(() => {
  if (state.auth.status === "restored") return "Offline cached access"
  if (!state.sync.connected) return "Offline"
  if (state.sync.status === "syncing") return "Syncing"
  return "Online"
})
```

Disable mutation buttons while offline:

```vue
<button :disabled="!canWrite" @click="save">
  Save
</button>
```

Do not hide cached data just because the socket is offline. Offline read is the point.

## Refresh after reconnect

The client does this automatically when the socket opens:

```text
socket open -> autoAuth -> syncNow
```

Manual refresh can be one call:

```js
async function refresh() {
  await state.syncNow()
}
```

Do not reload every row manually. `listRef` and `load` update through sync.

## Logout behavior

For shared devices, clear the local database on logout:

```js
async function logout() {
  await state.logout()
  await state.clearLocalDB()
}
```

`logout()` alone forgets auth. `clearLocalDB()` also removes cached documents, query refs, `time1`, and session id.

## Cache versioning

Change `CACHE_NAME` when you ship incompatible assets:

```js
const CACHE_NAME = "my-admin-v2"
```

Optionally clean old caches on activate:

```js
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))
    )
  )
})
```

## Production checklist

- Cache the app shell with a service worker.
- Keep db-state writes online-only.
- Show cached data in `restored` auth state.
- Disable save/delete buttons when socket is offline.
- Call `clearLocalDB()` on logout for shared devices.
- Version the service-worker cache when assets change.
- Keep server log retention longer than the longest expected offline period.
