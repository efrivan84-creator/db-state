# Server API reference

> [English](../../en/server/api-reference.md) · **Русский**

Справочник по публичному API `@db-state/server-mongo`.

## Exports

```js
import {
  createDbStateServer,
  createAuth,
  createHandlers,
  handleRpc,
  createSocketHub,
  defaultPassword,
  defaultAuthHash,
  hashValue
} from "@db-state/server-mongo"
```

## `createDbStateServer(config)`

```js
const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  access,
  hooks
})
```

### `DbStateServerConfig`

| Option | Значение |
|---|---|
| `mongo` | Mongo database-like object. |
| `tables` | Прикладные таблицы. |
| `access` | Code access config. |
| `hooks` | Lifecycle hooks. |
| `password` | Password adapter. |
| `socket` | Socket hub config. |
| `files` | File modules. |
| `syncLimit` | Max changes за sync. |
| `systemUserId` | Actor для внутренних writes. |

## `DbStateServer`

```ts
{
  add(input)
  update(input)
  remove(input)
  load(input)
  getIds(input)
  getUnique(input)
  count(input)
  sync(input)
  socket
  config
}
```

### `add(input)`

```js
await dbState.add({
  table: "order",
  obj: { _id: "o1", status: "open" },
  req
})
```

Вставляет документ, пишет `info.makeid/makedata`, append log и возвращает `change`.

### `update(input)`

```js
await dbState.update({
  table: "order",
  id: "o1",
  set: { status: "closed" },
  unset: [],
  req
})
```

Проверяет write access и field access, применяет patch, пишет `info.editid/editdata`.

### `remove(input)`

```js
await dbState.remove({ table: "order", id: "o1", req })
```

Удаляет документ и сохраняет pre-image в `change.old`.

### `load(input)`

```js
await dbState.load({ table: "order", id: "o1", req })
```

Возвращает документ с учетом `read.fields`.

### `getIds(input)`

```js
await dbState.getIds({
  table: "order",
  filter: { status: "open" },
  sort: { createdAt: -1 },
  skip: 0,
  limit: 50,
  req
})
```

Возвращает id разрешенных документов.

### `getUnique(input)`

```js
await dbState.getUnique({ table: "order", field: "status", filter: {}, req })
```

Возвращает уникальные разрешенные значения поля.

### `count(input)`

```js
await dbState.count({ table: "order", filter: { status: "open" }, req })
```

Считает разрешенные документы.

### `sync(input)`

```js
await dbState.sync({
  from: "1970-01-01T00:00:00.000Z",
  sessionId: "u1_abcd",
  req
})
```

Возвращает `{ to, changes }` с permission filtering.

## `socket: SocketHub`

```js
dbState.socket.addClient(ws, meta?)
dbState.socket.broadcast(message)
dbState.socket.clients
```

Socket hub обрабатывает `dbstate:*` messages и может пропускать custom events приложения.

## `ClientMeta`

```ts
{
  user?: object
  userId?: string
  sessionId?: string
}
```

## `PasswordHasher`

```ts
{
  hash(password: string): Promise<string>
  verify(password: string, passwordHash: string): Promise<boolean>
}
```

## Access types

Access rule возвращает boolean, decision object или `undefined`:

```ts
type AccessDecision =
  | boolean
  | { action?: boolean; fields?: string[] }
  | undefined
```

## Lifecycle hooks

```js
hooks: {
  beforeRead(ctx) {},
  afterRead(ctx) {},
  errorRead(ctx) {},
  beforeWrite(ctx) {},
  afterWrite(ctx) {},
  errorWrite(ctx) {},
  order: {
    beforeWrite(ctx) {}
  }
}
```

### Hook lookup order

Глобальный hook выполняется первым, затем table hook:

```text
hooks.beforeRead -> hooks.order.beforeRead
```

### Read order

```text
beforeRead
Mongo read
access/filter/projection
afterRead
```

При ошибке вызывается `errorRead`, но ошибка не глотается.

### Write order

```text
beforeWrite
strip client info
access check
Mongo write
append log
afterWrite
broadcast wake-up
```

### Mutable fields

`beforeRead` может менять `filter`, `sort`, `skip`, `limit`, `from`. `beforeWrite` может менять `obj`, `set`, `unset`.

### Errors

`errorRead` и `errorWrite` получают `ctx.error`. Используй их для audit/metrics, не для скрытого восстановления.

### Avoiding recursion

Если hook пишет через db-state API, следи, чтобы он не вызывал сам себя бесконечно. Для side effects лучше использовать отдельную таблицу или internal flag.

## Custom handlers

`createHandlers` и `handleRpc` экспортируются для низкоуровневой интеграции. В обычном приложении достаточно `createDbStateServer()` и `socket.addClient()`.

## Mongo abstraction

Сервер использует duck-typed Mongo API: `collection().findOne`, `updateOne`, `insertOne`, `deleteOne`, `find().sort().skip().limit().toArray()`. Это позволяет тестировать на in-memory adapter.

## `SyncResult`

```ts
{
  to: string
  changes: Change[]
}
```

RPC envelope может дополнительно содержать `meta.accessFiltered`, `meta.fieldsFiltered`, `meta.denied`.

## Performance limits

Следи за:

- индексом `log`;
- индексами прикладных query;
- `syncLimit`;
- количеством `loadDoc()` в code access rules;
- post-filtering permissions на больших list/count.
