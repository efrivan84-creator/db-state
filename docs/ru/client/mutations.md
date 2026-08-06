# Мутации

> [English](../../en/client/mutations.md) · **Русский**

Мутации клиента - это `add`, `update` и `remove`. Все они идут через WebSocket RPC, проверяются серверными permissions, пишут MongoDB и append-only log, затем применяются локально на клиенте.

## `add`

```js
const result = await state.order.add({
  _id: "o1",
  status: "open",
  total: 100
}, "order-form")
```

Сервер:

1. Удаляет client-supplied `info`.
2. Проверяет `write` и `write_fields`.
3. Добавляет `info.makeid` и `info.makedata`.
4. Вставляет документ в MongoDB.
5. Пишет `insert` change в log.
6. Возвращает `{ ok: true, change }`.

Клиент применяет change к reactive store и cache.

## `update`

```js
await state.order.update({
  id: "o1",
  set: {
    status: "closed",
    "profile.city": "Moscow"
  },
  unset: ["draft"]
}, "order-form")
```

`set` использует dot-path поля. `unset` удаляет поля по dot-path.

Можно передать `objedit`, если удобнее отправить уже собранный patch:

```js
await state.order.update({
  id: "o1",
  objedit: { status: "closed" }
})
```

### Diff-based updates

Для форм лучше считать diff между original и draft:

```js
const set = diffSet(original, draft)
await state.order.update({ id: draft._id, set })
```

Так два пользователя, редактирующие разные поля, не затирают друг друга целым документом.

### Permissions

`write_fields` проверяет каждое поле в `set`, `unset` и insert object. Если хотя бы одно поле запрещено, вся операция отклоняется.

## `remove`

```js
await state.order.remove("o1", "order-form")
```

Сервер проверяет document-level `write`, удаляет строку из MongoDB и пишет `delete` change с полным `old` документом.

## Локальные эффекты

После успешного RPC клиент:

- применяет change к reactive object;
- обновляет IndexedDB/cache;
- вызывает global и table hooks;
- планирует refresh `idsRef` и `countRef` для таблицы;
- обновляет loading key, если он был передан.

## Optimistic UI

db-state не применяет mutation до ответа сервера. Это осознанно: серверные permissions, field filtering и server-owned `info` являются источником истины. Если нужен мгновенный UI, показывай локальный draft или pending state рядом с фактическим документом.

## Ошибки

```js
try {
  await state.order.update({ id, set })
} catch (error) {
  formError.value = error.message
}
```

Типичные причины:

- socket offline;
- auth не восстановилась за `writeAuthTimeout`;
- `Write denied`;
- запрещенное поле;
- серверный hook выбросил ошибку;
- MongoDB rejected write.

## Bulk operations

В текущей версии нет transaction/batch API. Для массовых операций:

- делай loop на клиенте, если допустима частичная обработка;
- создай server-side domain action, если нужна атомарность или бизнес-инварианты;
- не пиши напрямую в Mongo, если хочешь сохранить sync и audit.

## Lifecycle summary

```text
client mutation
  -> wait for authorization
  -> WebSocket RPC
  -> server access/hooks
  -> Mongo write
  -> append log
  -> rpc_result(change)
  -> local applyChange
  -> cache write
  -> query refs refresh
  -> broadcast wakes other clients
```
