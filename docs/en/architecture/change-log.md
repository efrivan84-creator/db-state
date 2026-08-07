# Change log

The `log` collection is the backbone of db-state. Every successful write appends one immutable record. Clients do not subscribe to MongoDB collections directly; they ask the server for log entries newer than their last applied cursor.

## Why the log exists

The log solves three separate problems with one structure:

- **Realtime sync**: clients can reconnect and ask for `createdAt > time1`.
- **Audit trail**: every change stores `createdAt`, `userId`, `table`, `id`, and the mutation payload.
- **Delete recovery**: delete entries store `old`, so the system still knows what was removed after the source document is gone.

The current table state is MongoDB's normal collection state. The log is the ordered history that explains how clients should catch up.

## Log entry shape

All writes are normalized into a `Change`:

```js
{
  _id: "uuid-or-custom-id",
  createdAt: "2026-05-22T17:30:42.456Z",
  table: "order",
  id: "o1",
  action: "update",       // "insert" | "update" | "delete"
  set: { status: "done" },
  unset: ["draft"],
  obj: undefined,         // full inserted doc for insert
  old: undefined,         // full deleted doc for delete
  sessionId: "u1_abc123",
  userId: "u1"
}
```

`userId` is intentionally compact. The user document can change over time, so the log stores the actor id, not a duplicated user snapshot.

## Insert

An insert writes the full object to the target collection and to `change.obj`:

```js
{
  table: "order",
  id: "o1",
  action: "insert",
  obj: { _id: "o1", status: "open", total: 1200 },
  userId: "u_admin"
}
```

The client applies this by creating or updating the local reactive document. If the page already called `state.order.load("o1")`, the Vue client updates the existing reactive object in place instead of replacing it, so components keep their subscriptions.

## Update

An update stores only the patch:

```js
{
  table: "order",
  id: "o1",
  action: "update",
  set: { status: "packed" },
  unset: ["draftComment"]
}
```

Use dot paths for nested fields:

```js
await state.order.update({
  id: "o1",
  set: {
    "shipping.city": "Berlin",
    "shipping.zip": "10115"
  }
})
```

This keeps log entries small and makes diff-based forms natural. Two users can update different fields without overwriting each other's fields.

## Delete

A delete stores the full pre-image in `old`:

```js
{
  table: "order",
  id: "o1",
  action: "delete",
  old: { _id: "o1", status: "packed", total: 1200 },
  userId: "u_admin"
}
```

This is required for:

- audit screens;
- sync permission checks after the document is removed;
- restoring deleted records;
- time-travel reconstruction.

## Required indexes

Create the sync index:

```js
await db.collection("log").createIndex({ createdAt: 1, _id: 1 })
```

The sync query is:

```js
db.collection("log")
  .find({
    createdAt: { $gt: from, $lte: to },
    sessionId: { $ne: currentSessionId }
  })
  .sort({ createdAt: 1, _id: 1 })
```

`to` covers at most 12 hours after `from`; the client follows `hasMore` windows until caught up. Cursors older than 20 days receive a cache-reset marker instead of a historical replay.

## Permission filtering

Raw log entries are not sent blindly. During `sync()` the server checks read permissions for every change.

Fast path:

- `user.access` is merged at login and lives on the socket — no permission reads during sync.
- A `{}` grant decides from `table + user` without loading the changed document.
- A row filter is evaluated by the database: one `findOne` per change that already includes the filter.
- A row filter is checked by the database with one filtered `findOne` per change; `{}` grants and `fullaccess` need no document read at all.

Field filtering happens after access is allowed:

- `insert`: `obj` is projected to `read_fields`;
- `update`: only allowed `set`/`unset` paths remain;
- `delete`: `old` is projected to `read_fields`.

If an update contains no allowed fields after projection, it is dropped from the sync response.

## Time-travel reconstruction

To reconstruct a document at a point in time:

1. Find log entries for `{ table, id }` with `createdAt <= targetTime`.
2. Sort by `{ createdAt: 1, _id: 1 }`.
3. Apply changes in order:
   - `insert`: replace state with `obj`;
   - `update`: apply `set` and `unset`;
   - `delete`: state becomes `null`.

Sketch:

```js
import { applyPatch } from "@db-state/core"

async function documentAt(db, table, id, at) {
  const changes = await db.collection("log")
    .find({ table, id, createdAt: { $lte: at } })
    .sort({ createdAt: 1, _id: 1 })
    .toArray()

  let doc = null

  for (const change of changes) {
    if (change.action === "insert") doc = { ...change.obj }
    if (change.action === "update" && doc) applyPatch(doc, change)
    if (change.action === "delete") doc = null
  }

  return doc
}
```

## Restoring a deleted document

Because `delete` stores `old`, restore is just a new insert:

```js
const deleted = await db.collection("log").findOne({
  table: "order",
  id: "o1",
  action: "delete"
})

await state.order.add(deleted.old)
```

The restore itself creates a new log entry. The audit trail remains complete: original delete and later restore are both visible.

## Retention

The log grows forever unless you prune it. Keep it for at least:

- the longest period a client can be offline while still expected to sync incrementally;
- the audit retention window your product requires;
- the period needed for support/debugging.

If you prune aggressively, have a fallback:

- clear affected clients' local cache;
- emit `dbstate:force_resync`;
- or rebuild from a server snapshot.

For most admin tools, keeping the log for months or years is practical with the `{ createdAt, _id }` index.
