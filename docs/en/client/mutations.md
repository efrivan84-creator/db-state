# Mutations

> **English** · [Русский](../../../ru/client/mutations.md)

Three methods write to the server: `add`, `update`, `remove`. Each one runs the change through the server's permission layer, appends it to the log, and broadcasts a `changes_available` notification to other connected clients.

## `add`

Inserts a new document.

```js
const result = await state.order.add({
  _id: `o_${crypto.randomUUID()}`,
  status: "open",
  total: 1200,
  customerId: "u_123",
  createdAt: new Date().toISOString()
})

// result.ok === true
// result.id === "o_..."
// result.change === { logId, createdAt, table, id, action: "insert", obj, sessionId, userId }
```

Notes:

- If you don't pass `_id`, the server generates one (via `createLogId`, default `crypto.randomUUID()`).
- The full inserted object goes into the log as `obj`. Other clients receive it directly on their next `sync` (no extra `findOne`).
- Permission check: `write` access for the new document. Field-level `write.fields` is enforced — any forbidden field in `obj` rejects the whole insert.

## `update`

Sets and/or unsets fields on an existing document.

```js
await state.order.update({
  id: "o1",
  set:   { status: "closed", closedAt: new Date().toISOString() },
  unset: ["holdReason"]
})
```

Two equivalent syntaxes:

```js
// objedit is a historical alias for set; both go to MongoDB as $set
state.order.update({ id: "o1", objedit: { status: "closed" } })
state.order.update({ id: "o1", set:     { status: "closed" } })
```

Dot-path keys are supported:

```js
state.user.update({
  id: "u_123",
  set: {
    "profile.city": "Moscow",
    "profile.theme": "dark",
    "settings.notifications.email": false
  }
})
```

This translates to a MongoDB `$set` with the same paths. No intermediate objects required.

### Diff-based updates (recommended)

By default `update` sends every field you pass. If two users edit different fields of the same document, the second `update` will only overwrite the fields it explicitly includes — but if you naively pass `update({ id, set: draftCopy })` with the *whole draft*, you'll wipe out the other user's concurrent change to a field you happen to have an old value for.

The cookbook has a [diff-based save pattern](../cookbook/admin-panel.md#diff-based-saves) — compute changes between the original snapshot and your draft, send only those. This is what `demo2` does.

### Permissions

The server runs `assertAccess('write', ...)` against the document. If `write.fields` is set on a matching permission rule, every dot-path in `set` and `unset` must be in the whitelist:

```js
// _permission row:
{ table: "order", write: { groups: ["manager"], fields: ["status", "comment"] } }

// As a manager:
state.order.update({ id: "o1", set: { status: "closed" } })            // ✅
state.order.update({ id: "o1", set: { margin: 999 } })                 // ❌ "Write denied: field margin"
state.order.update({ id: "o1", set: { "comment.text": "ok" } })        // ✅ comment.text is under comment
```

Read more: [server/permissions.md](../server/permissions.md).

## `remove`

Deletes a document.

```js
await state.order.remove("o1")
```

Notes:

- Permission check: document-level `write` access. **Field-level `write.fields` does not apply to remove** — if you need stricter delete rules, use [code access rules](../server/code-access-rules.md) with `action === "delete"`.
- The full deleted document is stored in the log as `change.old`. This is what makes deletes safe for sync: clients that need to check read permissions on the deleted doc can still see what was there.

## Local effects of a mutation

When a mutation succeeds, the client:

1. Receives the `change` from the server.
2. Calls `state.applyChange(change)` internally, which:
   - Mutates the reactive document in `state.order.items[id]`.
   - Writes/deletes the cached row in IndexedDB.
   - Schedules a debounced refresh of all matching `countRef` / `idsRef`.

Components observing the doc, the list, or the count update **without any imperative invalidation**.

## Optimistic UI

The library does not do optimistic mutations by itself — every `add`/`update`/`remove` awaits the server response before reflecting locally. This keeps the cache consistent with permission decisions.

If you want optimistic UI, do it in your component:

```js
async function close(id) {
  const original = order.status
  order.status = "closed"          // optimistic
  try {
    await state.order.update({ id, set: { status: "closed" } })
  } catch (e) {
    order.status = original        // revert
    throw e
  }
}
```

For most CRUD admin workloads, the round-trip is < 50 ms and the conservative path is fine — most users don't notice.

## Errors

Mutations throw on:

- **Permission denied**: `"Write denied"` or `"Write denied: field X"`.
- **Unknown table**: `"Unknown db-state table: foo"`.
- **Unauthenticated socket**: `"Unauthorized"` (client not logged in).
- **RPC timeout**: `"db-state RPC timeout: update"` after `rpcTimeout` ms (default 15s).
- **Server error**: the error message returned by the server.

Wrap them in try/catch and surface to the user:

```js
try {
  await state.order.update({ id, set })
  notice.value = "Saved"
} catch (err) {
  error.value = err.message
}
```

## Bulk operations

The library exposes one-at-a-time CRUD. For bulk operations:

```js
// Don't loop unbounded — broadcast amplification
for (const id of ids) await state.order.update({ id, set: {...} })  // ❌

// Use Promise.all for parallelism within rate-limits
await Promise.all(
  ids.slice(0, 10).map((id) => state.order.update({ id, set: {...} }))
)

// For very large batches, do it server-side and rely on sync to update clients
```

If you genuinely need bulk inserts/updates from the client, consider exposing a custom RPC handler on the server (see [server/api-reference.md](../server/api-reference.md#custom-handlers)).

## Lifecycle summary

```
┌────────────┐  RPC update/add/remove   ┌────────────┐
│   client   ├──────────────────────────► │   server   │
└────────────┘                            └─────┬──────┘
        ▲                                       │
        │                                ┌──────▼──────┐
        │                                │ assertAccess │
        │                                │  Mongo write │
        │                                │  appendLog   │
        │                                └──────┬──────┘
        │      rpc_result {change}              │
        │ ◄─────────────────────────────────────┤
        │                                       │
        │            changes_available          │
        │ ◄─────────── broadcast ───────────────┤
        │                          (other clients)
        │
   applyChange(change)
   refresh countRef/idsRef
```

The originating client gets the change in the RPC response. Other clients get the `changes_available` ping and pull the diff via `sync`.
