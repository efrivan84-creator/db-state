# Cookbook: advanced patterns

> [English](../../en/cookbook/advanced-patterns.md) · **Русский**

Набор практических паттернов для приложений поверх db-state.

## Diff-based forms

Храни original и draft отдельно, отправляй только измененные поля:

```js
const set = diffSet(original, draft)
await state.order.update({ id: draft._id, set })
```

Это уменьшает конфликты и лучше сочетается с `write.fields`.

## Soft delete

Вместо `remove()`:

```js
await state.order.update({
  id,
  set: { deleted: true, deletedAt: new Date().toISOString() }
})
```

Все списки должны фильтровать `{ deleted: { $ne: true } }` или эквивалентный application filter. Для текущей equality permission model часто проще делать soft-delete через code hooks/prefilters.

## Multi-tenant data

Добавляй `tenantId` в документы и пользователя:

```js
hooks: {
  beforeRead(ctx) {
    ctx.filter = { ...ctx.filter, tenantId: ctx.user.tenantId }
  },
  beforeWrite(ctx) {
    if (ctx.action === "insert") ctx.obj.tenantId = ctx.user.tenantId
  }
}
```

Не доверяй tenant filter с клиента.

## Owner-based permissions

```js
access: {
  order: {
    read: async ({ user, loadDoc }) => {
      const doc = await loadDoc()
      return doc?.ownerId === user._id
    }
  }
}
```

Для sync это может загружать документы, поэтому short-circuit admin/common cases до `loadDoc()`.

## Custom loading indicators

```js
const page = state.getKeyRef("order-page")
const rows = state.order.listRef(query, "order-page")
await state.order.update({ id, set }, "order-page")
```

Один key может покрывать initial load и submit progress.

## Sharing the socket with app events

```js
state.socket.on("presence:update", ({ payload }) => {
  presence[payload.userId] = payload
})

state.socket.send("presence:update", { docId, status: "editing" })
```

Сохраняемое состояние - через db-state tables. Эфемерное состояние - через custom events.

## Rate-limited query refresh

На write-heavy таблицах увеличь debounce/rate settings server broadcast или делай custom aggregation. Query refs все равно refresh'ятся по changed table, а не по каждому отдельному change.

## Custom cache backend

Используй свой cache для encrypted storage, mobile shell или server-side tests:

```js
const cache = {
  async get(table, id) {},
  async set(table, id, value) {},
  async delete(table, id) {},
  async clear() {}
}
```

## Server-side indexes

Каждый `idsRef`, `getIds`, `countRef` должен иметь Mongo index под frequent filter/sort:

```js
await mongo.collection("order").createIndex({ status: 1, createdAt: -1 })
```

Permissions не заменяют индексы.

## Force resync after migrations

После bulk миграции, которая обошла db-state log, разошли:

```js
dbState.socket.broadcast({ type: "dbstate:force_resync" })
```

Лучше все же писать миграции через domain script, который добавляет log rows или требует clear cache.

## Scaling broadcasts

Стандартный broadcast - process-local. Для нескольких Node-процессов добавь Redis/NATS pubsub wake-up. Публикуй только сигнал, не сами данные: каждый клиент выполнит `sync()` со своими permissions.
