# Реактивные запросы

> [English](../../en/client/reactive-queries.md) · **Русский**

Клиентский API строится вокруг одного правила: документ загружается один раз, дальше все списки, карточки и формы работают с тем же reactive object.

## Краткая справка

| Метод | Назначение |
|---|---|
| `load(id, key?)` | Вернуть reactive document и загрузить его из cache/server. |
| `idsRef(query)` | Reactive ref со списком id для Mongo-like query. |
| `listRef(query, key?)` | Computed список документов: `idsRef` + `load` для каждого id. |
| `countRef(filter)` | Reactive ref со счетчиком документов. |
| `getAsync(id, key?)` | Одноразовое async-чтение документа. |
| `getIds(query)` | Одноразовый запрос id. |
| `getUnique(query)` | Одноразовый запрос уникальных значений поля. |

## `load`

```js
const user = state.user.load("u1", "profile")
```

`load` сразу возвращает reactive object. Если данные есть в IndexedDB, объект заполняется из cache. Если cache miss и socket авторизован, клиент делает RPC `load`.

Для одного `table/id` всегда возвращается один и тот же объект:

```js
state.user.load("u1") === state.user.load("u1") // true
```

Это значит, что таблица, карточка и форма редактирования видят один документ. Когда sync применяет patch, объект обновляется на месте.

### Loading keys

`key` связывает несколько операций с одним progress object:

```js
const loading = state.getKeyRef("order-page")

const order = state.order.load(orderId, "order-page")
const items = state.item.listRef({ filter: { orderId } }, "order-page")
```

`loading.value`, `loading.max`, `loading.percent` можно показывать в UI.

### Ошибки

```js
const error = state.order.getError(orderId)
const isLoading = state.order.isLoading(orderId)
```

Ошибки чтения хранятся на уровне `table/id`. При повторной загрузке состояние может измениться.

## `idsRef`

```js
const ids = state.order.idsRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  skip: 0,
  limit: 50
})
```

`ids.value` содержит массив id. Значение кэшируется, поэтому UI может отрисоваться до reconnect.

### Дедупликация

Одинаковые query возвращают один и тот же ref. В ключ входят `filter`, `sort`, `skip`, `limit`, поэтому разные страницы pagination не смешиваются.

### Persistence

Значения `idsRef` сохраняются в cache table `__dbstate_query`. После логина и sync changed tables ref обновляется с сервера.

## `listRef`

```js
const orders = state.order.listRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  limit: 50
}, "orders")
```

`listRef` - это computed поверх `idsRef`. Для каждого id он вызывает `load(id, key)`, поэтому записи из списка и отдельная карточка остаются связаны.

### Master + detail

```js
const orders = state.order.listRef({ limit: 50 }, "orders")
const selectedId = ref("")
const selectedOrder = computed(() =>
  selectedId.value ? state.order.load(selectedId.value, "orders") : null
)
```

Если selected row уже есть в списке, карточка получит тот же reactive object без второго server fetch.

## `countRef`

```js
const openCount = state.order.countRef({ status: "open" })
```

Счетчик кэшируется и обновляется после логина, локальных мутаций и synced changes своей таблицы.

### Несколько счетчиков

```js
const counts = {
  open: state.order.countRef({ status: "open" }),
  closed: state.order.countRef({ status: "closed" }),
  failed: state.order.countRef({ status: "failed" })
}
```

Одинаковые filters дедуплицируются.

## `getAsync`

```js
const order = await state.order.getAsync("o1")
```

Это одноразовое чтение. В отличие от `load`, оно ждет authorization, потому что результат не сможет обновиться сам после позднего login.

## `getIds`

```js
const ids = await state.order.getIds({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  skip: 50,
  limit: 50
})
```

Подходит для command-like сценариев, где reactive ref не нужен.

## `getUnique`

```js
const statuses = await state.order.getUnique({
  field: "status",
  filter: { archived: false }
})
```

Сервер возвращает разрешенные уникальные значения с учетом permissions.

## Триггеры refresh

Query refs обновляются:

- после успешного `login()`;
- после `authByHash()` и sync, если были changes этой таблицы;
- после локальных `add`, `update`, `remove`;
- после `syncNow()`, если batch содержит changed table.

## Частые проблемы

### `countRef` показывает старое значение

Проверь, пришел ли `changes_available`, прошел ли `syncNow()`, и есть ли read permission на таблицу. Сервер молча скрывает недоступные строки — `countRef` считает только разрешённые, и сколько скрыто, клиенту не сообщается.

### `listRef` показывает дубликаты после навигации

Не создавай новый `state` на каждый mount. `createDbState()` должен быть singleton-модулем.

### Pagination не сбрасывает список

Включай `skip` и `limit` в query. `idsRef` учитывает оба поля в ключе дедупликации.
