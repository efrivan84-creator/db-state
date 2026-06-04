# Client API reference

> [English](../../en/client/api-reference.md) · **Русский**

Справочник по публичному API `@db-state/vue`.

## Exports

```js
import {
  createDbState,
  createIndexedDbCache,
  createMemoryCache,
  createStorageCache
} from "@db-state/vue"
```

Пакет также re-export'ит часть типов из `@db-state/core` через `.d.ts`.

## `createDbState<TSchema>(options | tables)`

```js
const state = createDbState({
  tables: ["user", "order"],
  wsUrl: "ws://127.0.0.1:8788/db-state/ws"
})
```

Сокращение:

```js
const state = createDbState(["user", "order"])
```

### Основные options

| Option | Default | Значение |
|---|---:|---|
| `tables` | required | Таблицы приложения. Service tables добавляются автоматически. |
| `wsUrl` | текущий host | WebSocket URL. |
| `cache` | IndexedDB | Cache backend. |
| `autoAuth` | `true` | Пробовать hash auth при старте. |
| `safetySyncInterval` | `0` | Optional polling fallback. |
| `writeAuthTimeout` | `3000` | Сколько writes ждут authorization. |
| `storagePrefix` | `db-state` | Prefix для local/session storage keys. |

## `DbState<TSchema>`

`state` - reactive object с системными полями и table API:

```js
state.auth
state.sync
state.socket
state.order.load("o1")
state.order.update({ id: "o1", set: { status: "closed" } })
```

### `sync`

```ts
{
  connected: boolean
  status: "idle" | "syncing" | "error"
  time1: string
  error?: Error
}
```

### `auth`

```ts
{
  status: "anonymous" | "restored" | "authorizing" | "authorized" | "error"
  userId?: string
  groups?: string[]
  error?: Error
}
```

### `syncNow()`

```js
await state.syncNow()
```

Выполняет RPC `sync`, применяет batch, пишет cache и refresh'ит query refs по changed tables.

### `applyChange(change)`

```js
await state.applyChange(change)
```

Применяет change к локальному reactive store и cache. Обычно вызывается самой библиотекой.

### `onChange(callback)`

```js
const off = state.onChange((change) => {
  console.log(change.table, change.id)
})

off()
```

Вызывается после локального применения change.

### `clearLocalDB()`

```js
await state.clearLocalDB()
```

Очищает cache, in-memory tables, query refs и сбрасывает sync cursor.

### `getKeyRef(key)` / `resetKey(key)`

```js
const loading = state.getKeyRef("order-form")
loading.value
loading.max
loading.percent
loading.ready
```

`key` можно передавать в `load`, `listRef`, `add`, `update`, `remove`, чтобы UI видел общий progress.

## `TableApi<T>`

У каждой таблицы есть одинаковый API:

```ts
load(id, key?)
getAsync(id, key?)
getIds(query?)
getUnique(query)
idsRef(query?)
listRef(query?, key?)
countRef(filter?)
add(obj, key?)
update({ id, set, unset, objedit }, key?)
remove(id, key?)
onChange(callback)
onAdd(callback)
onEdit(callback)
onDelete(callback)
getError(id)
isLoading(id)
```

## `ListQuery<T>`

```ts
{
  filter?: Filter<T>
  sort?: Sort<T>
  skip?: number
  limit?: number
}
```

`filter` и `sort` передаются серверу как Mongo-like query pieces.

## `UpdateArgs<T>`

```ts
{
  id: string
  set?: Record<string, unknown>
  unset?: string[]
  objedit?: Partial<T>
}
```

`set` и `unset` поддерживают dot-path.

## `MutationResult<T>`

```ts
{
  ok: true
  change: Change<T>
}
```

## Socket facade

```js
state.socket.connect()
state.socket.on(type, handler)
state.socket.send(type, payload)
state.socket.rpc(method, payload)
state.socket.system(type, payload)
state.socket.raw
```

Для пользовательских событий обычно нужны только `on` и `send`.

## Cache backends

```js
createIndexedDbCache({ name?: string })
createStorageCache({ storage?: Storage, prefix?: string })
createMemoryCache()
```

Custom backend должен реализовать async `get`, `set`, `delete`, `clear`.

## `ReactiveDoc<T>`

Документ - Vue reactive object с служебными полями:

```ts
T & {
  __loaded?: boolean
  __loading?: boolean
  __error?: unknown
  __cacheChecked?: boolean
}
```

Не сохраняй служебные поля обратно в MongoDB.

## Service table types

Service tables добавляются автоматически:

```text
_user
_group
_permission
```

Доступ к ним все равно контролируется permissions.

## Core types

В TypeScript доступны `Change<T>`, `Filter<T>`, `Sort<T>`, `DbStateMessage` и другие типы из core declarations.
