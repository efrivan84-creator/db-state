# Cookbook: audit trail

> [English](../../en/cookbook/audit-trail.md) · **Русский**

db-state уже пишет append-only log для каждой успешной мутации. На его основе можно построить ленту активности, историю документа и восстановление удалений.

## Что уже записывается

```js
{
  _id,
  createdAt,
  table,
  id,
  action,
  set,
  unset,
  obj,
  old,
  sessionId,
  userId
}
```

`insert` хранит `obj`, `update` хранит patch, `delete` хранит `old`.

## Индексы

```js
await mongo.collection("log").createIndex({ createdAt: -1 })
await mongo.collection("log").createIndex({ table: 1, id: 1, createdAt: -1 })
await mongo.collection("log").createIndex({ userId: 1, createdAt: -1 })
```

Основной sync index `{ createdAt: 1, _id: 1 }` тоже обязателен.

## Recent activity feed

```js
const rows = await mongo.collection("log")
  .find({})
  .sort({ createdAt: -1 })
  .limit(100)
  .toArray()
```

Перед показом проверь права. Не отдавай полный log обычному пользователю без фильтрации.

## История документа

```js
const history = await mongo.collection("log")
  .find({ table: "order", id: "o1" })
  .sort({ createdAt: -1, _id: -1 })
  .limit(100)
  .toArray()
```

Это дает timeline конкретной записи.

## Активность пользователя

```js
const activity = await mongo.collection("log")
  .find({ userId: "u1" })
  .sort({ createdAt: -1 })
  .limit(100)
  .toArray()
```

Для отображения имени пользователя сделай join с `_user`, но не копируй весь user object в log.

## Field-level display

Для update показывай `set` и `unset`:

```js
function describe(change) {
  if (change.action === "insert") return "создал запись"
  if (change.action === "delete") return "удалил запись"
  return [
    ...Object.keys(change.set ?? {}).map((field) => `изменил ${field}`),
    ...(change.unset ?? []).map((field) => `очистил ${field}`)
  ].join(", ")
}
```

## Восстановить документ на момент времени

Прочитай changes до target time и примени их по порядку:

```js
const changes = await mongo.collection("log")
  .find({ table, id, createdAt: { $lte: targetTime } })
  .sort({ createdAt: 1, _id: 1 })
  .toArray()
```

Затем проиграй `insert`, `update`, `delete`.

## Восстановить удаление

Найди delete change:

```js
const deleted = await mongo.collection("log").findOne({
  table: "order",
  id: "o1",
  action: "delete"
})
```

Вставь `deleted.old` через обычный server API или domain action, чтобы восстановление само попало в log.

## Безопасный доступ к audit

Не открывай коллекцию `log` напрямую всем пользователям. Сделай:

- admin-only endpoint;
- db-state таблицу/view с ограниченными полями;
- server action, который фильтрует по tenant/user permissions.

## Retention strategy

Храни log минимум столько, сколько клиенты могут быть offline и потом догонять sync. Если audit нужен дольше, раздели operational sync retention и archival audit storage.
