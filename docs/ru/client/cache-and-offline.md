# Кэш и офлайн

> [English](../../en/client/cache-and-offline.md) · **Русский**

db-state читает cache-first: реактивные документы и query refs могут отрисоваться до восстановления socket/auth, а после authorization догоняются через server RPC и sync.

## Что кэшируется

| Данные | Где |
|---|---|
| Документы таблиц | IndexedDB/cache backend |
| `idsRef` и `countRef` values | IndexedDB/cache backend |
| `time1` | `localStorage` |
| `userId` и auth hash | `localStorage` |
| `sessionId` | `sessionStorage` |

Офлайн-записи не ставятся в очередь. Writes требуют online socket и authorization.

## Cache backends

### `createIndexedDbCache(options?)`

Backend по умолчанию для браузера:

```js
import { createDbState, createIndexedDbCache } from "@db-state/vue"

createDbState({
  tables,
  wsUrl,
  cache: createIndexedDbCache({ name: "my-app-db-state" })
})
```

Подходит для production UI и offline read.

### `createStorageCache(options?)`

Использует Web Storage, обычно `localStorage`:

```js
createStorageCache({ storage: localStorage, prefix: "db-state:" })
```

Подходит для небольших объемов и простых демо.

### `createMemoryCache()`

```js
createDbState({ tables, wsUrl, cache: createMemoryCache() })
```

Ничего не переживает reload. Удобно для тестов.

### Custom backend

Backend должен реализовать `get`, `set`, `delete`, `clear` для table/id. Используй его для encrypted storage, native shell или shared cache.

## Порядок старта страницы

1. `createDbState()` создает reactive store.
2. `load`/`idsRef`/`countRef` читают cache.
3. Socket открывается.
4. `authByHash()` подтверждает saved credentials.
5. `syncNow()` догоняет log.
6. Cache-missed reactive reads ретраятся.

## Показать cached UI до auth

```js
const order = state.order.load(route.params.id, "order-page")
const ready = computed(() => order.__loaded || state.auth.status === "authorized")
```

Так пользователь видит последнее сохраненное состояние даже во время reconnect.

## Cache busting после deploy

Если схема документов изменилась несовместимо:

```js
createIndexedDbCache({ name: "my-app-db-state-v2" })
```

Или вызови:

```js
await state.clearLocalDB()
```

## Clear cache on logout

`login()` нового пользователя очищает локальный state. Для явного logout можно дополнительно вызвать:

```js
await state.logout()
await state.clearLocalDB()
```

если продукт не должен показывать cached data на shared device.

## Offline writes

Не поддерживаются специально. Очередь offline writes требует conflict resolution, retries, idempotency и UX для неуспешных операций. db-state выбирает честное поведение: чтение работает, запись без socket падает.

## Service Worker integration

Service worker кэширует app shell и assets. db-state кэширует данные. Не пытайся проксировать WebSocket через service worker; просто дай приложению открыться offline и показать IndexedDB state.

## Размеры

IndexedDB нормально держит тысячи и десятки тысяч документов для админок и B2B UI. Для очень больших таблиц не грузите все: используйте `filter`, `sort`, `skip`, `limit`, индексы MongoDB и narrow query refs.

## Когда не кэшировать

Не кэшируй или шифруй кэш, если документы содержат данные, которые нельзя оставлять на устройстве после logout: medical, financial, shared kiosk, чужой компьютер. В таких сценариях используй memory cache или обязательный `clearLocalDB()`.
