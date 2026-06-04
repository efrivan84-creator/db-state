# Cookbook: админ-панель

> [English](../../en/cookbook/admin-panel.md) · **Русский**

Типичный use case db-state - админка с таблицами, карточкой записи, правами и realtime обновлениями.

## Цель

Собрать UI, где пользователь:

- логинится;
- видит список записей с pagination/filter/sort;
- выбирает запись и редактирует draft;
- сохраняет только измененные поля;
- получает live updates от других пользователей.

## Client state singleton

```js
// src/state.js
import { createDbState } from "@db-state/vue"

export const state = createDbState({
  tables: ["order", "user", "_permission"],
  wsUrl: "ws://127.0.0.1:8788/db-state/ws"
})
```

Создавай `state` один раз в модуле. Не создавай его внутри компонента.

## Реактивные списки

```js
const query = computed(() => ({
  filter: {
    status: status.value || undefined
  },
  sort: { createdAt: -1 },
  skip: page.value * pageSize.value,
  limit: pageSize.value
}))

const rows = computed(() =>
  state.order.listRef(query.value, "orders").value
)

const total = computed(() =>
  state.order.countRef(query.value.filter).value
)
```

`listRef` и `countRef` кэшируются и обновляются после sync.

## Выбранная запись

```js
const selectedId = ref("")

const selectedOrder = computed(() => {
  if (!selectedId.value) return null
  return state.order.load(selectedId.value, "order-editor")
})
```

Если запись уже есть в таблице, editor получит тот же reactive object.

## Draft form

Не редактируй reactive document напрямую, если нужна кнопка "Отмена":

```js
const draft = reactive({})
const original = ref({})

watch(selectedOrder, (order) => {
  Object.assign(draft, structuredClone(cleanDoc(order ?? {})))
  original.value = structuredClone(cleanDoc(order ?? {}))
})
```

`cleanDoc` должен убрать служебные `__loaded`, `__loading`, `__error`.

## Diff-based saves

```js
function diffSet(original, next) {
  const set = {}
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(value) !== JSON.stringify(original[key])) {
      set[key] = value
    }
  }
  return set
}

async function save() {
  const set = diffSet(original.value, draft)
  if (Object.keys(set).length === 0) return

  await state.order.update({
    id: selectedId.value,
    set
  }, "order-editor")
}
```

Diff-based save уменьшает конфликтность и лучше работает с field-level permissions.

## Server permissions

```js
await mongo.collection("_permission").insertMany([
  {
    _id: "perm_order_admin",
    table: "order",
    priority: 10,
    read: { groups: ["admin"], action: true },
    write: { groups: ["admin"], action: true }
  },
  {
    _id: "perm_order_manager",
    table: "order",
    priority: 5,
    read: { groups: ["manager"], fields: ["_id", "status", "total"], action: true },
    write: { groups: ["manager"], fields: ["status"], action: true }
  }
])
```

UI может скрывать поля, но безопасность обеспечивает только сервер.

## Refresh button

```js
async function refresh() {
  await state.syncNow()
}
```

Обычно refresh не нужен, потому что `changes_available` запускает sync. Но кнопка полезна для диагностики и ручного восстановления.

## Production checklist

- `state` singleton.
- Mongo indexes под все table queries.
- `_permission` seed для каждой таблицы.
- Diff-based save вместо отправки всего документа.
- Loading keys для крупных страниц.
- Error states на форму.
- `clearLocalDB()` при смене пользователя или schema version.
- Server hooks для tenant prefilter.
- Audit UI поверх `log`, если нужен history.
