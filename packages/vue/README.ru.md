# @db-state/vue

> [English](README.md) · **Русский**

Маленький реактивный Vue 3 клиент для [db-state](https://github.com/efrivan84-creator/db-state): типизированные таблицы, `listRef` / `idsRef` / `countRef`, логин, sync, офлайн-кэш. Примерно **4 KB brotli**.

Создаёт глобальный реактивный объект состояния, под капотом — WebSocket RPC, локальный кэш и серверный sync.

## Что входит

- Маленький глобальный Vue store, который зеркалит MongoDB-таблицы через db-state RPC.
- Прямой API для страниц: `state.order.load(id).status`, `state.order.update(...)`, `state.order.listRef(...)`.
- Реактивные query-ref'ы: `idsRef`, `listRef`, `countRef` с `filter`, `sort`, `skip`, `limit`.
- Дедупликация запросов: одинаковый query возвращает тот же ref, а не создаёт новую refresh-петлю.
- Cache-first query-ref'ы: закэшированные ids/counts сразу рисуются из IndexedDB, потом обновляются после логина или изменений таблицы.
- Офлайн-чтение документов, id, count, auth hash и `time1`.
- Loading-группы через `getKeyRef(key)` для skeleton/progress целой страницы или блока.
- WebSocket RPC, reconnect, `login`, `authByHash`, `logout` и кастомные события приложения по тому же сокету.
- TypeScript generics для имён таблиц, фильтров, sort-ключей, полей документов и update payload.

## Установка

```sh
npm install @db-state/vue
```

`vue` (>=3.0.0) — peer-зависимость.

## Подключение

```js
import { createDbState } from "@db-state/vue"

export const state = createDbState(["user", "order", "product"])
```

Используется как singleton. В одном приложении обычно должен быть один экземпляр `state`.

### TypeScript

Передай schema-generic — каждый таб-аксессор станет типизированным относительно него, включая фильтры, sort-ключи, поля update и результаты load:

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
//                                          ^ "open" | "closed" — типизировано
```

Служебные таблицы (`_user`, `_group`, `_permission`) типизированы автоматически с разумными дефолтами и могут быть переопределены в схеме.

`_user`, `_group` и `_permission` добавляются автоматически:

```js
state._user.load(userId)
state._group.getIds()
state._permission.getIds()
```

Сервер всё равно принимает решение о доступе через обычные permission-правила.

## Использование на странице

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
})
```

## Table API

У каждой таблицы один и тот же набор методов:

```js
state.user.load(id, key)
state.user.getAsync(id, key)
state.user.getIds(query, key)
state.user.getUnique(query, key)
state.user.countRef(filter)
state.user.idsRef(query)
state.user.listRef(query, key)
state.user.update({ id, objedit })
state.user.add(obj)
state.user.remove(id)
state.user.isLoading(id)
state.user.getError(id)
```

### Кратко по методам

| Метод | Что возвращает / делает |
|---|---|
| `load(id, key?)` | Возвращает один реактивный документ и грузит его из кэша/сервера при необходимости. |
| `getAsync(id, key?)` | Одноразовая async-загрузка документа. |
| `getIds(query, key?)` | Одноразовый запрос id с `filter`, `sort`, `skip`, `limit`. |
| `getUnique(query, key?)` | Одноразовый запрос уникальных значений поля. |
| `add(obj)` | Создаёт документ и применяет вернувшееся изменение локально. |
| `update({ id, set, unset, objedit })` | Патчит документ и обновляет локальный state/cache после успеха. |
| `remove(id)` | Удаляет документ и убирает его из локального state/cache. |
| `countRef(filter)` | Реактивный закэшированный count для фильтра. |
| `idsRef(query)` | Реактивный закэшированный список id для query. |
| `listRef(query, key?)` | Computed-список: `idsRef(query)` + `load(id, key)`. |
| `isLoading(id)` / `getError(id)` | Состояние запроса конкретного документа. |

Реактивные чтения (`load`, `idsRef`, `listRef`, `countRef`) работают cache-first. Они не вызывают защищенные серверные RPC, пока `state.auth.status !== "authorized"`. Если кэш не найден, пока auth/сокет еще не готовы, loaded-маркер остается false и чтение перезапрашивается после авторизации.

Одноразовые чтения (`getAsync`, `getIds`, `getUnique`) ждут авторизацию, потому что их результат уже не обновится. Для UI лучше использовать реактивные методы. Записи (`add`, `update`, `remove`) ждут авторизацию до `writeAuthTimeout` (по умолчанию 3000 мс), затем выбрасывают ошибку, если сокет все еще не авторизован.

### Реактивные запросы

`countRef(filter)` возвращает Vue `ref` со значением count'а от сервера для фильтра:

```js
const openCount = state.order.countRef({ status: "open" })
```

При создании ref сначала читает последнее закэшированное значение из IndexedDB/кэша и сразу сервер не дёргает. Count обновляется после ручного логина, после изменений таблицы и после hash-аутентификации только если у этого ref еще не было кэшированного значения. Обновленное значение записывается обратно в кэш. Если запросить тот же `countRef` повторно с теми же таблицей и фильтром — вернётся существующий ref.

`idsRef(query)` возвращает Vue `ref` со списком id, подходящих под серверный запрос:

```js
const orderIds = state.order.idsRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  skip: 0,
  limit: 50
})
```

Объект query уходит на сервер как `{ table, ...query }`, так что `filter`, `sort`, `skip`, `limit` поддерживаются тем же API. При создании ref сначала читает последние закэшированные id из IndexedDB/кэша и сразу сервер не дёргает. ids-ref обновляется после ручного логина, после изменений таблицы и после hash-аутентификации только если у этого ref еще не было кэшированного значения. Обновленное значение сохраняется в кэш. Повторный запрос того же query для той же таблицы вернёт существующий ref.

`listRef(query, key)` — page-level хелпер для списков:

```js
const orders = state.order.listRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  skip: 0,
  limit: 50
}, "orders")
```

Внутри это просто `idsRef(query)` плюс `load(id, key)`:

```js
computed(() => ids.value.map((id) => state.order.load(id, key)))
```

Второго кэша объектов он не держит. Список id, загрузка документов, sync-обновления и IndexedDB-кэш остаются раздельными.

Создание идёт cache-first:

```text
countRef/idsRef создан -> читаем кэшированное значение -> ждем authorized + пустой кэш или изменение таблицы -> refresh с сервера -> сохраняем в кэш
```

`countRef` и `idsRef` используют стабильный ключ, построенный из объекта настроек. Порядок ключей в объекте не важен:

```js
state.order.idsRef({ filter: { status: "open" }, limit: 10 })
state.order.idsRef({ limit: 10, filter: { status: "open" } })
// тот же самый ref
```

## WebSocket

Библиотека использует WebSocket как единственный транспорт.

Системные события идут с префиксом `dbstate:*` и зарезервированы.

Кастомные события приложения разрешены:

```js
state.socket.on("auth:expired", refreshToken)
state.socket.send("client:ready", { page: "orders" })
```

## Аутентификация

Логин:

```js
await state.login("ivan", "password")
```

Сервер возвращает `userId` и `hash`. Клиент сохраняет их в `localStorage`.

Реконнект с сохранёнными кредами:

```js
await state.authByHash()
```

Auto-auth включён по умолчанию:

```js
export const state = createDbState({
  tables: ["user", "order", "product"],
  autoAuth: true
})
```

Когда сокет открывается после обновления страницы, клиент читает сохранённые `userId/hash`, вызывает `authByHash`, перезапрашивает реактивные чтения, которые не загрузились из кэша/auth, потом запускает sync. Кэшированные `countRef`/`idsRef` не обновляются только из-за восстановления auth; они обновятся, когда sync вернёт изменения по таблицам. Если сервер отклонил сохранённый hash, клиент очищает auth-данные и переходит в анонимное состояние.

Можно запустить тот же поток вручную:

```js
const ok = await state.autoAuth()
```

Логаут на этом устройстве:

```js
await state.logout()
```

Logout забывает только локальный `hash`. Чтобы разлогинить все устройства, ротируй `_user.hash` на сервере.

## Офлайн-чтение

Vue-клиент умеет читать закэшированные данные офлайн:

- документы грузятся из IndexedDB/кэша через `load(id)`;
- `countRef` и `idsRef` сначала читают свои последние закэшированные значения;
- сохранённые `userId/hash` поднимают клиент в статусе `restored`, так что обновлённая страница может показывать закэшированные данные до того, как поднимется сокет;
- при реконнекте сокета `authByHash` проверяет сохранённый hash, а `sync` применяет приходящие изменения лога.

Сама application shell должна кэшироваться приложением-хостом, обычно через service worker. demo2 регистрирует для этого `db-state-offline-sw.js`.

## Хранилище

По умолчанию:

- `sessionStorage` хранит `sessionId`;
- `localStorage` хранит `time1`;
- `localStorage` хранит `userId/hash` для аут;
- IndexedDB хранит закэшированные записи и закэшированные значения `idsRef`/`countRef`;
- memory-кэш используется, когда IndexedDB недоступен.

Адаптеры кэша:

```js
import {
  createIndexedDbCache,
  createMemoryCache,
  createStorageCache
} from "@db-state/vue"
```

## Полезные ссылки

- Полная документация: [docs/en](../../docs/en/README.md)
- Реактивные запросы: [docs/en/client/reactive-queries.md](../../docs/en/client/reactive-queries.md)
- Кэш и офлайн: [docs/en/client/cache-and-offline.md](../../docs/en/client/cache-and-offline.md)
- Cookbook админки: [docs/en/cookbook/admin-panel.md](../../docs/en/cookbook/admin-panel.md)

## Внутренние файлы

- `index.js` — `createDbState`, глобальный state и петля sync.
- `table.js` — методы таблиц.
- `socket.js` — WebSocket RPC.
- `cache.js` — адаптеры кэша.
- `keys.js` — трекинг прогресса по page-key.
- `storage.js` — хелперы session и storage.
