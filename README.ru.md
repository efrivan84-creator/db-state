# db-state

> [English](README.md) · **Русский**

[![npm @db-state/vue](https://img.shields.io/npm/v/@db-state/vue?label=%40db-state%2Fvue)](https://www.npmjs.com/package/@db-state/vue)
[![npm @db-state/server-mongo](https://img.shields.io/npm/v/@db-state/server-mongo?label=%40db-state%2Fserver-mongo)](https://www.npmjs.com/package/@db-state/server-mongo)
[![license](https://img.shields.io/npm/l/@db-state/vue)](LICENSE)

Реактивное состояние базы данных для Vue 3 + MongoDB.

db-state позволяет читать документы MongoDB на странице как обычный Vue state:

```js
const user = state.user.load(userId)

user.name
user.email
user.profile.city
```

Объект реактивный. Если другой клиент изменит эту же строку, сервер запишет изменение в log, отправит WebSocket-уведомление, клиент подтянет diff через sync, и этот же объект обновится на месте.

Также есть реактивные запросы к базе:

```js
const orders = state.order.listRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  skip: 0,
  limit: 50
})

const openOrderCount = state.order.countRef({ status: "open" })
```

`orders` и `openOrderCount` - это Vue refs/computed значения, за которыми стоят MongoDB, IndexedDB-кэш, права доступа и WebSocket sync. Добавления, удаления и удалённые обновления автоматически обновляют списки и счетчики.

## Зачем это нужно

Почти в каждой админке приходится снова собирать одну и ту же цепочку:

```text
MongoDB -> server API -> WebSocket -> client cache -> Vue state -> page
```

db-state превращает эту цепочку в маленькую библиотеку:

- прямой реактивный доступ к документам базы;
- реактивные списки и счетчики на основе MongoDB queries;
- автоматический sync между вкладками и пользователями;
- серверные read/write права, включая поля;
- append-only audit log для каждого изменения;
- офлайн-чтение из IndexedDB;
- один WebSocket для data RPC и кастомных событий приложения.

Цель не заменить MongoDB или Vue state. Цель - сделать состояние из MongoDB естественным на Vue-странице.

## Главная идея

Создаёшь один объект состояния:

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

И используешь его прямо на страницах:

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
  <div v-if="loading > 0">Загрузка...</div>
  <div>Открытых заказов: {{ openCount }}</div>

  <button
    v-for="order in orders"
    :key="order._id"
    @click="closeOrder(order)"
  >
    {{ order._id }} - {{ order.status }} - {{ order.total }}
  </button>
</template>
```

Не нужен отдельный Pinia store, ручная invalidation-логика, WebSocket reducer или boilerplate загрузки на каждой странице. `listRef`, `countRef` и `load` используют одни реактивные объекты и общий кэш.

## Как работает sync

```text
client update()
  -> WebSocket RPC
  -> MongoDB write
  -> append log row
  -> debounced/rate-limited broadcast changes_available
  -> all clients sync(time1)
  -> local reactive objects, lists, counters and IndexedDB cache update
```

Каждая запись создаёт одну неизменяемую строку log:

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

Клиенты хранят `time1` - время последнего полностью применённого sync. После reconnect или уведомления они запрашивают у сервера log-строки в `(time1, now]`. Сервер фильтрует изменения по правам доступа перед отправкой.

## Реактивный API базы

У каждой таблицы одинаковые методы:

| Client API | Для чего |
|---|---|
| `load(id, key?)` | Возвращает один реактивный документ и грузит его из кэша/сервера. |
| `getAsync(id, key?)` | Одноразовая async-загрузка. |
| `getIds({ filter, sort, skip, limit })` | Одноразовый запрос id. |
| `idsRef({ filter, sort, skip, limit })` | Реактивный закэшированный список id. |
| `listRef({ filter, sort, skip, limit }, key?)` | Реактивный computed-список документов. |
| `countRef(filter)` | Реактивный закэшированный счетчик по MongoDB-фильтру. |
| `state.onChange(fn)` | Глобальный хук на каждое примененное изменение. |
| `state.order.onAdd/onEdit/onDelete(fn)` | Хуки таблицы после insert, update и delete. |
| `add(obj)` | Вставляет документ и применяет вернувшееся изменение локально. |
| `update({ id, set, unset, objedit })` | Патчит документ и обновляет local state/cache. |
| `remove(id)` | Удаляет документ и убирает его из local state/cache. |
| `getKeyRef(key)` | Считает активные загрузки для страницы/блока. |

Важное поведение:

- `load(id)` всегда возвращает один и тот же реактивный объект для table/id.
- `listRef(query)` - это `idsRef(query)` плюс `load(id)`, поэтому таблица и карточка записи связаны.
- `idsRef` и `countRef` дедуплицируются. Один и тот же query возвращает тот же ref.
- `idsRef` и `countRef` сохраняются в IndexedDB, поэтому списки и счетчики видны до reconnect сокета.
- Query refs обновляются после логина, локальных записей и synced изменений таблицы.

## Права доступа

По умолчанию доступ запрещён. Сервер проверяет каждый RPC:

```text
code rule for table+doc
  -> code rule for table
  -> _permission rules
  -> deny
```

Правила лежат в `_permission`:

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

Поля проверяются на сервере:

- `read.fields` проецирует `load()`, `getUnique()` и sync changes.
- `write.fields` валидирует `add()` и `update()`.
- `write` управляет insert, update и delete.
- Delete log rows хранят `old`, поэтому audit и permission checks работают после удаления исходного документа.

Если декларативных правил мало, используй code access hooks. Они могут решить доступ по user/table/log entry или лениво вызвать `ctx.loadDoc()` только когда нужен сам документ.

## Авторизация и офлайн-чтение

Пользователи хранятся в `_user`:

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

Клиент поддерживает:

```js
await state.login("admin", "password")
await state.authByHash()
await state.logout()
```

Auth hash хранится на клиенте и переиспользуется после обновления страницы. На сервере hash общий для пользователя, поэтому новая вкладка не сбрасывает старые сессии. Чтобы разлогинить все устройства, ротируй `_user.hash`.

Реактивное чтение работает cache-first и безопасно для auth: `load`, `idsRef`, `listRef` и `countRef` сразу показывают кэш и отправляют защищенные RPC только после `state.auth.status === "authorized"`. Если чтение не нашло кэш, пока сокет был офлайн или авторизация еще шла, оно перезапросится после авторизации. Одноразовые чтения (`getAsync`, `getIds`, `getUnique`) ждут авторизацию, потому что их результат уже не обновится реактивно.

Где хранятся данные клиента:

| Данные | Storage |
|---|---|
| Документы | IndexedDB |
| Значения `idsRef` / `countRef` | IndexedDB |
| Sync cursor `time1` | `localStorage` |
| `userId` / auth hash | `localStorage` |
| `sessionId` | `sessionStorage` |

Офлайн-записи намеренно не ставятся в очередь. Если сокет офлайн, запись падает, чтобы потом не решать конфликты. Закэшированное чтение продолжает работать.

## Настройка сервера

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

Рекомендуемые индексы MongoDB:

```js
await mongo.collection("log").createIndex({ createdAt: 1, logId: 1 })
await mongo.collection("_permission").createIndex({ table: 1, priority: -1 })
await mongo.collection("order").createIndex({ status: 1, createdAt: -1 })
```

## Пакеты

| Пакет | Размер | Для чего |
|---|---:|---|
| [`@db-state/core`](packages/core) | ~1.5 KB min+gz | Общий протокол, `Change`, dot-path helpers, sync-window helpers. Без runtime-зависимостей. |
| [`@db-state/vue`](packages/vue) | ~5 KB min+gz | Vue 3 reactive client: документы, списки, счетчики, auth, cache, WebSocket sync. |
| [`@db-state/server-mongo`](packages/server-mongo) | ~5 KB min+gz | MongoDB WebSocket server: CRUD, auth, log, sync, permissions, audit. |

## Установка

```sh
npm install @db-state/vue @db-state/server-mongo
```

`@db-state/core` установится автоматически как зависимость.

## Демо

```sh
npm install

npm run demo:server
npm run demo:client
npm run demo:smoke

npm run demo2:server
npm run demo2:client
npm run demo2:smoke
```

- `demo/` - минимальная Vue-страница с in-memory Mongo-like сервером.
- `demo2/` - полноценная админка заказов, пользователей, групп, прав, real MongoDB и offline PWA shell.

Демо-пользователи:

```text
admin / admin
manager / manager
viewer / viewer    // demo2
```

## Документация

- [Полная документация](docs/en/README.md)
- [Реактивные запросы](docs/en/client/reactive-queries.md)
- [Права доступа](docs/en/server/permissions.md)
- [Sync protocol](docs/en/architecture/sync-protocol.md)
- [Cookbook админки](docs/en/cookbook/admin-panel.md)
- [Changelog](CHANGELOG.ru.md)

## Статус проекта

Ранний релиз, `0.0.x`. API намеренно маленький, но это ещё pre-1.0. Изменения и текущие ограничения вынесены в [CHANGELOG.ru.md](CHANGELOG.ru.md).

Лицензия: MIT.
