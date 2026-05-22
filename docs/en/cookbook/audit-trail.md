# Cookbook: audit trail

db-state writes an append-only log for every mutation. You can use the same log for support screens, user activity feeds, compliance exports, and rollback tools.

## What is already recorded

Every write creates one entry in `log`:

```js
{
  logId: "77c1...",
  createdAt: "2026-05-22T17:30:42.456Z",
  table: "order",
  id: "o1",
  action: "update",
  set: { status: "packed" },
  unset: undefined,
  obj: undefined,
  old: undefined,
  sessionId: "u_admin_w8k2p9d2aa",
  userId: "u_admin"
}
```

For `delete`, `old` contains the full deleted document:

```js
{
  action: "delete",
  old: { _id: "o1", status: "packed", total: 1200 }
}
```

The log stores `userId`, not a full user snapshot. Join to `_user` when you need names.

## Create indexes

Use at least:

```js
await db.collection("log").createIndex({ createdAt: 1, logId: 1 })
await db.collection("log").createIndex({ table: 1, id: 1, createdAt: -1 })
await db.collection("log").createIndex({ userId: 1, createdAt: -1 })
```

The first index is for sync. The others are for audit screens.

## Recent activity feed

```js
async function recentActivity(db, limit = 100) {
  return db.collection("log")
    .find({})
    .sort({ createdAt: -1, logId: -1 })
    .limit(limit)
    .toArray()
}
```

Display compact labels:

```js
function describe(change) {
  if (change.action === "insert") return `created ${change.table}/${change.id}`
  if (change.action === "delete") return `deleted ${change.table}/${change.id}`

  const fields = [
    ...Object.keys(change.set ?? {}),
    ...(change.unset ?? [])
  ]
  return `updated ${change.table}/${change.id}: ${fields.join(", ")}`
}
```

## Per-document history

```js
async function historyFor(db, table, id) {
  return db.collection("log")
    .find({ table, id })
    .sort({ createdAt: 1, logId: 1 })
    .toArray()
}
```

This is the basis of a "History" tab in an admin panel.

## User activity

```js
async function activityByUser(db, userId, from, to) {
  return db.collection("log")
    .find({
      userId,
      createdAt: { $gt: from, $lte: to }
    })
    .sort({ createdAt: -1, logId: -1 })
    .toArray()
}
```

Join users:

```js
async function withUsers(db, changes) {
  const ids = [...new Set(changes.map((c) => c.userId).filter(Boolean))]
  const users = await db.collection("_user").find({ _id: { $in: ids } }).toArray()
  const byId = new Map(users.map((u) => [u._id, u]))

  return changes.map((change) => ({
    ...change,
    actor: byId.get(change.userId)
  }))
}
```

## Field-level display

For updates, show `set` and `unset` separately:

```js
function changedFields(change) {
  if (change.action === "insert") return Object.keys(change.obj ?? {})
  if (change.action === "delete") return Object.keys(change.old ?? {})

  return [
    ...Object.keys(change.set ?? {}),
    ...(change.unset ?? [])
  ]
}
```

For sensitive fields, redact before showing:

```js
const secretFields = new Set(["passwordHash", "hash"])

function redactPatch(change) {
  const set = Object.fromEntries(
    Object.entries(change.set ?? {}).map(([key, value]) => [
      key,
      secretFields.has(key) ? "[redacted]" : value
    ])
  )

  return { ...change, set }
}
```

## Reconstruct a document at a time

```js
import { applyPatch } from "@db-state/core"

async function documentAt(db, table, id, at) {
  const changes = await db.collection("log")
    .find({ table, id, createdAt: { $lte: at } })
    .sort({ createdAt: 1, logId: 1 })
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

This is useful for "what did the customer see yesterday?" support questions.

## Restore deleted data

```js
async function restoreDeletedOrder(state, db, id) {
  const entry = await db.collection("log").findOne(
    { table: "order", id, action: "delete" },
    { sort: { createdAt: -1, logId: -1 } }
  )

  if (!entry?.old) throw new Error("No deleted document found")

  await state.order.add(entry.old)
}
```

The restore creates a new `insert` log entry. Do not edit the old delete log.

## Expose audit data safely

The `log` collection is not a normal db-state table by default. Keep it server-side unless you explicitly build an audit API.

Recommended pattern:

- create a dedicated server endpoint or WebSocket method for audit queries;
- check permissions before returning log entries;
- redact sensitive fields;
- never expose password hashes or auth hashes;
- paginate by `{ createdAt, logId }`.

## Retention strategy

Decide retention explicitly:

- short-lived sync log only: keep enough history for offline clients;
- product audit log: keep months or years;
- compliance log: export to cold storage before pruning.

If you delete old log entries, clients with older `time1` cannot catch up incrementally. In that case, call `state.clearLocalDB()` on the client or broadcast `dbstate:force_resync` after rebuilding a safe baseline.
