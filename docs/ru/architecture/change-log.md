# Change log

> [English](../../en/architecture/change-log.md) · **Русский**

Append-only log - центральный механизм sync, аудита и восстановления. Каждая успешная запись в прикладную таблицу создает одну неизменяемую строку в коллекции `log`.

## Зачем нужен log

- Клиенты могут догонять сервер после reconnect по `time1`.
- Можно показать audit trail: кто, когда и что изменил.
- Удаления не требуют tombstones в основной таблице, потому что старый документ хранится в `change.old`.
- Можно восстановить состояние документа на прошлый момент, проиграв изменения.

## Форма записи

```js
{
  _id: "log_1",
  createdAt: "2026-05-22T10:00:00.000Z",
  table: "order",
  id: "o1",
  action: "update", // insert | update | delete
  set: { status: "closed" },
  unset: [],
  obj: null,
  old: null,
  sessionId: "u1_abcd",
  userId: "u1"
}
```

`userId` - компактный actor id. Полный объект пользователя в log не пишется.

## Insert

Insert log содержит полный вставленный объект:

```js
{
  action: "insert",
  table: "order",
  id: "o1",
  obj: { _id: "o1", status: "open", total: 100 }
}
```

Клиент может создать документ из `obj`, даже если раньше его не было в кэше.

## Update

Update log хранит только patch:

```js
{
  action: "update",
  set: { status: "closed" },
  unset: ["draft"]
}
```

Клиент применяет `set`/`unset` к уже загруженному документу. Если документ не был полностью загружен, частичный update не создает неполный документ в кэше.

## Delete

Delete log хранит old document:

```js
{
  action: "delete",
  old: { _id: "o1", status: "closed", total: 100 }
}
```

Это нужно для audit, восстановления и permission checks после удаления основной записи.

## Обязательные индексы

```js
await mongo.collection("log").createIndex({ createdAt: 1, _id: 1 })
```

Для audit views полезны:

```js
await mongo.collection("log").createIndex({ table: 1, id: 1, createdAt: -1 })
await mongo.collection("log").createIndex({ userId: 1, createdAt: -1 })
```

## Permission filtering

Sync не отдает log rows, которые пользователь не имеет права читать. Field-level `read_fields` фильтрует `obj`, `set`, `unset` и `old`. Поэтому audit UI для обычного пользователя должен использовать отдельные access-настройки, а не прямой доступ к полной коллекции `log`.

## Time-travel reconstruction

Чтобы восстановить документ на момент времени:

1. Найди все changes для `table/id` с `createdAt <= targetTime`.
2. Отсортируй по `{ createdAt, _id }`.
3. Примени `insert`, `update`, `delete` по порядку.

Пример:

```js
function applyHistory(changes) {
  let doc

  for (const change of changes) {
    if (change.action === "insert") doc = structuredClone(change.obj)
    if (change.action === "update" && doc) {
      for (const [path, value] of Object.entries(change.set ?? {})) {
        setByPath(doc, path, value)
      }
      for (const path of change.unset ?? []) {
        unsetByPath(doc, path)
      }
    }
    if (change.action === "delete") doc = undefined
  }

  return doc
}
```

## Восстановление удаленного документа

Для простого восстановления можно взять `change.old` из delete log и вставить документ заново через обычный `add()` или доменную server action. Лучше не писать напрямую в коллекцию, чтобы новое восстановление тоже попало в log.

## Retention

Log растет бесконечно, пока ты его не чистишь. Retention зависит от двух требований:

- насколько долго клиенты могут быть offline и все еще догонять sync;
- сколько audit history нужно хранить по правилам продукта или закона.

Если чистишь старый log, сделай snapshot или force resync strategy для клиентов, чей `time1` старше retention boundary.
