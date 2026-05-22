# db-state

> [English](README.md) · **Русский**

[![npm @db-state/vue](https://img.shields.io/npm/v/@db-state/vue?label=%40db-state%2Fvue)](https://www.npmjs.com/package/@db-state/vue)
[![npm @db-state/server-mongo](https://img.shields.io/npm/v/@db-state/server-mongo?label=%40db-state%2Fserver-mongo)](https://www.npmjs.com/package/@db-state/server-mongo)
[![license](https://img.shields.io/npm/l/@db-state/vue)](LICENSE)

Маленький realtime-слой реактивного состояния для Vue 3 + MongoDB. Синхронизация по WebSocket, декларативные права доступа, офлайн-кэш, полная поддержка TypeScript — всё это примерно в **4 KB brotli** на клиенте.

## Пакеты

| Пакет | Размер (min+gz) | Что делает |
|---|---:|---|
| [`@db-state/core`](packages/core) | ~1.5 KB | Общий протокол, `Change`, dot-path хелперы. Без зависимостей. |
| [`@db-state/vue`](packages/vue) | ~5 KB | Vue 3 клиент: реактивные `listRef`/`idsRef`/`countRef`, CRUD, логин, IndexedDB-кэш, автосинхронизация по WebSocket. |
| [`@db-state/server-mongo`](packages/server-mongo) | ~5 KB | Сервер на Mongo: CRUD, append-only лог, sync, WebSocket RPC, права на уровне полей. |

## Быстрый старт

```sh
npm install @db-state/vue @db-state/server-mongo
```

**Клиент** (Vue 3):

```ts
import { createDbState } from "@db-state/vue"

type Schema = {
  order: { _id: string; status: "open" | "closed"; total: number }
}

export const state = createDbState<Schema>({ tables: ["order"] })

// В компоненте:
const open = state.order.listRef({ filter: { status: "open" }, sort: { total: -1 } })
await state.order.update({ id: "o1", set: { status: "closed" } })
```

**Сервер** (Node + Mongo + `ws`):

```ts
import { WebSocketServer } from "ws"
import { MongoClient } from "mongodb"
import { createDbStateServer } from "@db-state/server-mongo"

const mongo = (await new MongoClient(process.env.MONGO_URI).connect()).db("app")
const dbState = createDbStateServer({ mongo, tables: ["order"] })

new WebSocketServer({ port: 8788, path: "/db-state/ws" })
  .on("connection", (ws) => dbState.socket.addClient(ws))
```

## Демо

В репозитории два демо-проекта. **Оба используют опубликованные пакеты `@db-state/*`** — те же самые импорты, что напишет любой внешний пользователь. На локальной разработке монорепо подключает эти имена к `packages/*` через npm workspaces (симлинки), так что правки в исходниках сразу видны в демо.

### `demo/` — минимальный пример с in-memory Mongo

Самая простая возможная сборка: сервер на Node с in-memory-аналогом Mongo ([demo/server/memoryMongo.js](demo/server/memoryMongo.js)), клиент — одна Vue-страница, которая грузит один заказ и показывает запрет на запись поля. Никаких внешних сервисов.

Что показывает:
- `state.order.load(id)` с реактивным флагом `__loaded` и трекингом загрузки через page-key
- права на уровне полей: `manager` может править `status`/`comment`, но не `margin`
- smoke-тест ([demo/smoke.js](demo/smoke.js)) поднимает реальный сервер и гоняет его через WebSocket

```sh
npm install
npm run demo:server     # терминал 1 — WebSocket сервер на :8787
npm run demo:client     # терминал 2 — Vite dev сервер на http://127.0.0.1:5173
npm run demo:smoke      # одноразовый end-to-end тест (клиент не нужен)
```

Пользователи по умолчанию: `admin / admin`, `manager / manager` (пароли очевидно демонстрационные).

### `demo2/` — полноценная админка с настоящим MongoDB

Админ-панель из 4 вкладок ([demo2/client](demo2/client)) с живым CRUD над заказами, пользователями, группами и правами. Демонстрирует библиотеку целиком на настоящей MongoDB:

- типизированные реактивные таблицы (`order`, `_user`, `_group`, `_permission`)
- межвкладочные обновления в реальном времени: открой две вкладки браузера, поправь в одной — поля формы во второй обновятся мгновенно
- diff-based сохранение: по сети уходят только изменённые поля (нет field-level конфликтов между конкурентными редакторами)
- переключение ролей: `admin` видит всё, `manager` видит заказы без `margin` и может править только `status`/`comment`, `viewer` — только чтение с урезанной проекцией полей
- popover-подтверждение удаления
- редактор JSON-правил для `_permission` с автогенерацией `_id`
- офлайн-PWA через service worker ([demo2/client/public/db-state-offline-sw.js](demo2/client/public/db-state-offline-sw.js))

Нужен запущенный MongoDB. По умолчанию подключается к `mongodb://localhost:27017`; переопределить можно через env-переменные — полный список в [`.env.example`](.env.example).

```sh
npm install
# свой mongo (опционально — без него используется localhost:27017)
export DB_STATE_MONGO_URI="mongodb://user:pass@host:27017/?authSource=admin"

npm run demo2:server    # терминал 1 — WebSocket сервер на :8788
npm run demo2:client    # терминал 2 — Vite dev сервер на http://127.0.0.1:5174
npm run demo2:smoke     # одноразовый end-to-end тест
```

Пользователи по умолчанию: `admin / admin`, `manager / manager`, `viewer / viewer`.

### Как демо локально находят `@db-state/*`

Каждое демо импортирует библиотеку по её публичному имени:

```js
// demo2/client/src/state.js
import { createDbState } from "@db-state/vue"

// demo2/server/index.js
import { createDbStateServer } from "@db-state/server-mongo"
```

Корневой [`package.json`](package.json) объявляет `@db-state/core`, `@db-state/vue` и `@db-state/server-mongo` в зависимостях с версией `"*"`, и одновременно перечисляет `packages/*` в `workspaces`. При `npm install` npm видит и то, и другое — и создаёт симлинки `node_modules/@db-state/{core,vue,server-mongo}` → `packages/{core,vue,server-mongo}`. Vite и Node резолвят импорты через эти симлинки. Итог: код демо выглядит ровно как код потребителя, но каждая правка в `packages/*` отражается сразу, без `npm publish`.

## Клиент

```js
import { createDbState } from "@db-state/vue"

export const state = createDbState(["user", "order", "product"])
```

Служебные таблицы `_user`, `_group` и `_permission` добавляются автоматически и на клиенте, и на сервере, но к ним применяются обычные права чтения/записи.

Код на странице:

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

Реактивные хелперы для запросов:

- `load(id, key)` возвращает один реактивный документ, грузит его из кэша/сервера по мере необходимости.
- `idsRef({ filter, sort, skip, limit })` возвращает Vue `ref` со списком подходящих id.
- `listRef({ filter, sort, skip, limit }, key)` возвращает Vue `computed`-список документов, объединяя `idsRef` с `load(id, key)`.
- `countRef(filter)` возвращает Vue `ref` со значением count'а от сервера для этого фильтра.

`idsRef` и `countRef` дедуплицируются на таблицу. Повторный вызов с теми же настройками вернёт существующий ref, а не создаст новую refresh-петлю. Порядок ключей в объекте не важен.

`countRef` и `idsRef` сохраняются в клиентский кэш. При создании ref сначала читает последнее закэшированное значение из IndexedDB/кэша и сразу не дёргает сервер. Серверный refresh происходит после ручного логина и после прихода изменений таблицы через sync или локальную запись. Hash-аут и обновление страницы сами по себе не вызывают refresh query-ref'ов. Свежие серверные значения пишутся обратно в кэш.

Кастомные события через сокет тоже доступны. События `dbstate:*` зарезервированы за библиотекой.

```js
state.socket.on("auth:expired", refreshToken)
state.socket.send("client:ready", { page: "profile" })
```

Где хранится клиентское состояние по умолчанию:

- `sessionStorage` — для `sessionId`;
- `localStorage` — для `time1`;
- `localStorage` — для аут-данных `userId/hash`;
- IndexedDB — для кэша сущностей, с fallback на in-memory вне браузера.

Auto-auth включён по умолчанию. При реконнекте WebSocket или обновлении страницы клиент читает сохранённые `userId/hash`, вызывает `authByHash`, потом запускает sync. Сам по себе он `countRef`/`idsRef` не обновляет — только если sync вернёт изменения по таблице.

```js
export const state = createDbState({
  tables: ["user", "order", "product"],
  autoAuth: true
})
```

Если сохранённый hash отклонён сервером, клиент стирает сохранённые auth-данные и переходит в анонимное состояние.

## Сервер

```js
import { createDbStateServer } from "@db-state/server-mongo"

const dbState = createDbStateServer({
  mongo,
  tables: ["user", "order", "product"]
})
```

Пользователи живут в `_user` и аутентифицируются через WebSocket:

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

Поле `hash` для аут общее у пользователя и переиспользуется между логинами. Открытие новой вкладки его не ротирует и не сбрасывает существующие вкладки. Чтобы разлогинить все устройства, ротируй `_user.hash` на сервере.

API клиента:

```js
await state.login("ivan", "password")
await state.authByHash()
await state.logout()
```

Единственный транспорт — WebSocket. Подключи клиентов из своего `ws`/framework-адаптера:

```js
dbState.socket.addClient(ws, {
  user: {
    _id: userId,
    groups: ["manager"]
  },
  sessionId
})
```

По умолчанию доступ запрещён. Сервер проверяет:

```text
code rule для table+doc -> code rule для table -> _permission rules -> deny
```

Документы с правами лежат в `_permission`:

```js
{
  table: "order",
  priority: 10,
  if: { status: "open" },
  read: { groups: ["manager"], action: true, fields: ["_id", "status", "total"] },
  write: { groups: ["admin"], action: true, fields: ["status", "comment"] }
}
```

`fields` опционален. Если задан, чтения и приходящие в sync изменения проецируются на эти поля, а `add/update` отклоняют запрещённые поля для записи. У `remove` по-прежнему действует document-level `write`.

Входящие библиотечные сообщения — RPC через тот же сокет:

```js
{
  type: "dbstate:rpc",
  id: "rpc1",
  method: "update",
  payload: { table: "user", id: "u1", set: { fio: "Ivan" } }
}
```

Ответ сервера:

```js
{
  type: "dbstate:rpc_result",
  id: "rpc1",
  result: { ok: true, change }
}
```

Основной поток:

```text
клиент WS RPC update -> MongoDB -> log -> WebSocket changes_available -> клиенты WS RPC sync(time1)
```

Каждая запись лога хранит `userId`. Записи на удаление дополнительно хранят `old` — удалённый документ, так что sync-permissions и аудит продолжают работать даже после исчезновения исходной записи.

`sync` выбирает:

```js
createdAt > time1 && createdAt <= time2 && sessionId != currentSessionId
```

Клиент двигает `time1` только после того, как все полученные изменения применены и закэшированы.

Для проверки прав в sync документы из Mongo подгружаются только при необходимости. Правила без `_permission.if` проверяются по самой записи лога + `table/user/groups`; правила с `if` загружают текущий документ. Code-правила доступа могут лениво подтянуть документ через `ctx.loadDoc()`.

## Статус

Ранний релиз (`0.0.x`). API маленький и стабильный по форме, но обращайтесь как с pre-1.0:

- Realtime CRUD с правами, офлайн-кэшем, логином, sync — готово и протестировано (38 тестов).
- TypeScript-декларации — готовы, полная generic-типизация схемы.
- Append-only лог даёт аудит и time-travel rollback из коробки.
- DSL `if`-условий в правах сейчас понимает только равенство — операторы вроде `$in`, `$gte` в roadmap.
- `broadcast` рассылает ping `changes_available` всем клиентам при каждой записи; для >1000 одновременных клиентов нужна per-client фильтрация (пока не реализована).
- Только Vue + Mongo + WebSocket — никаких React/Postgres/etc адаптеров.

PR'ы приветствуются. Лицензия: MIT.
