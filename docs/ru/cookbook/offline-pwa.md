# Cookbook: offline PWA

> [English](../../en/cookbook/offline-pwa.md) · **Русский**

db-state поддерживает offline read: app shell открывается из service worker, данные берутся из IndexedDB, а после reconnect клиент догоняет sync.

## Что работает офлайн

Работает:

- показ уже закэшированных документов;
- `load`, `listRef`, `idsRef`, `countRef` из cache;
- UI навигация по app shell;
- сохраненный auth state в `restored`.

Не работает:

- `add`, `update`, `remove`;
- one-off reads, если данных нет в cache;
- login/hash auth без сети;
- file upload/download.

## Client setup

```js
export const state = createDbState({
  tables: ["order", "product"],
  wsUrl: "wss://app.example.com/db-state/ws",
  autoAuth: true
})
```

По умолчанию будет IndexedDB cache.

## Register service worker

```js
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js")
}
```

## Service worker

Минимальный app-shell cache:

```js
const CACHE = "app-shell-v1"
const ASSETS = ["/", "/index.html", "/assets/app.js", "/assets/style.css"]

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)))
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/index.html"))
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request))
  )
})
```

WebSocket не проксируется service worker.

## Offline UI state

```js
const offline = computed(() => !state.sync.connected)
const restored = computed(() => state.auth.status === "restored")
```

Покажи, что данные могут быть устаревшими:

```vue
<p v-if="offline">Нет связи. Показаны последние сохраненные данные.</p>
<p v-if="restored">Сессия будет проверена после reconnect.</p>
```

## Refresh после reconnect

Клиент сам выполнит auth/sync после восстановления socket. Для ручной кнопки:

```js
await state.syncNow()
```

## Logout behavior

На личном устройстве можно оставить cache после logout. На shared device лучше:

```js
await state.logout()
await state.clearLocalDB()
```

## Cache versioning

При несовместимой схеме:

```js
createIndexedDbCache({ name: "my-app-db-state-v3" })
```

И обнови service worker cache name.

## Production checklist

- HTTPS/WSS.
- Service worker кэширует только app shell, не secrets.
- IndexedDB cache versioning.
- Offline banner.
- Writes disabled offline.
- Clear cache policy для shared devices.
- Sync/error telemetry.
- Mongo log retention дольше максимального offline window.
