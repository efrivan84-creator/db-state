# Cookbook: advanced patterns

These patterns build on the core API without adding another state library.

## Diff-based forms

Keep a draft for inputs, then save only changed fields:

```js
function makePatch(original, draft, fields) {
  const set = {}
  const unset = []

  for (const field of fields) {
    const next = draft[field]
    const prev = original?.[field]

    if (next === "" || next === undefined) {
      if (prev !== undefined) unset.push(field)
    } else if (next !== prev) {
      set[field] = next
    }
  }

  return { set, unset }
}

async function save() {
  const { set, unset } = makePatch(order.value, draft, ["status", "comment", "ownerId"])

  await state.order.update({
    id: order.value._id,
    set,
    unset
  })
}
```

Benefits:

- smaller log entries;
- fewer accidental overwrites;
- better field-level permission behavior;
- clearer audit trail.

## Soft delete

Hard delete is supported and stores `old` in the log. Use soft delete when your UI wants a trash bin:

```js
await state.order.update({
  id,
  set: {
    deletedAt: new Date().toISOString(),
    deletedBy: state.auth.userId
  }
})
```

Default list:

```js
const activeOrders = state.order.listRef({
  filter: { deletedAt: undefined },
  sort: { createdAt: -1 }
})
```

Trash list:

```js
const deletedOrders = state.order.listRef({
  filter: { deletedAt: { $ne: undefined } },
  sort: { deletedAt: -1 }
})
```

The exact filter operators depend on your server's Mongo query handling. The Mongo-backed server passes filters to MongoDB.

## Multi-tenant data

Use an access filter with `"$groupid"` when the tenant is a document field — one group per tenant:

```js
// _group: one per tenant, tenantId equals the group id
{
  _id: "t1",
  name: "Tenant 1 managers",
  access: {
    order: {
      read: { tenantId: "$groupid" },
      write: { tenantId: "$groupid" },
      write_fields: ["status", "comment"]
    }
  }
}
```

For policies that data filters cannot express, a hook is the fallback:

```js
const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  hooks: {
    beforeRead: (ctx) => {
      if (ctx.table !== "order") return
      ctx.filter = { $and: [ctx.filter ?? {}, { tenantId: { $in: ctx.user.tenantIds ?? [] } }] }
    },
    beforeWrite: (ctx) => {
      if (ctx.table !== "order" || ctx.method === "add") return
      if (!ctx.user.tenantIds?.includes(ctx.old?.tenantId)) {
        return { allowed: false, reason: "Order belongs to another tenant" }
      }
    }
  }
})
```

The read hook rewrites the query, so the database never returns other tenants' rows.

## Owner-based permissions

Users read only their own tasks, admins read all. As data, with no code at all:

```js
{ _id: "staff", access: { task: { read: { ownerId: "$adminid" }, write: { ownerId: "$adminid" } } } }
{ _id: "admin", access: { task: { read: {}, write: {} } } }
```

When the condition needs code — say it depends on the time of day or an external
service — use a hook and leave the rest to the group access:

```js
hooks: {
  beforeRead: (ctx) => {
    if (ctx.user.disabled) return { allowed: false, reason: "Account disabled" }
    if (ctx.table === "task" && !ctx.user.groups?.includes("admin")) {
      ctx.filter = { $and: [ctx.filter ?? {}, { ownerId: ctx.user._id }] }
    }
    // nothing returned → the group access decides on the narrowed query
  }
}
```

## Custom loading indicators

`getKeyRef(key)` lets a page group loads under a name:

```js
const loading = state.getKeyRef("orders-page")
const orders = state.order.listRef({ sort: { createdAt: -1 } }, "orders-page")
// Include "_user" in createDbState({ tables }) if this page loads user metadata.
const user = state._user.load(state.auth.userId, "orders-page")
```

In Vue:

```vue
<div v-if="loading.value > 0">Loading... {{ 100 - loading.percent }}%</div>
<OrderTable v-else :rows="orders" />
```

The key counts active operations for all calls that use it. `max` stores the peak active count for the current loading wave, `percent` is the active percentage left (`value / max * 100`), and `start` stays `false` until the first operation starts.

This is useful for both read and write progress. Use one key for page reads (`load`, `listRef`, `getAsync`) to show loading progress, or pass the same key into mutations (`add`, `update`, `remove`) to show the progress of submitted changes being applied.

## Sharing the socket with app events

`dbstate:*` event names are reserved. Other names are available:

```js
state.socket.on("notification", (payload) => {
  notifications.value.unshift(payload)
})

state.socket.send("client:ready", {
  page: "orders"
})
```

On the server:

```js
dbState.socket.sendToUser("u1", "notification", {
  text: "Your report is ready"
})
```

Keep domain events separate from db-state changes. Use db-state for data sync; use custom events for messages, reminders, progress updates, and server-side jobs.

## Rate-limited query refresh

`idsRef` and `countRef` refresh after table changes. Defaults are short debounce delays:

```js
createDbState({
  tables: ["order"],
  countRefreshDelay: 50,
  idsRefreshDelay: 50
})
```

For high-write dashboards, increase them:

```js
createDbState({
  tables: ["event"],
  countRefreshDelay: 500,
  idsRefreshDelay: 500
})
```

Document changes still apply immediately. Only query aggregate refresh is delayed.

## Custom cache backend

The client accepts any cache with `get`, `set`, `delete`, and `clear`:

```js
const cache = {
  async get(table, id) {
    return JSON.parse(localStorage.getItem(`${table}:${id}`) ?? "null")
  },
  async set(table, id, value) {
    localStorage.setItem(`${table}:${id}`, JSON.stringify(value))
  },
  async delete(table, id) {
    localStorage.removeItem(`${table}:${id}`)
  },
  async clear() {
    localStorage.clear()
  }
}

export const state = createDbState({
  tables: ["order"],
  cache
})
```

Use the built-in IndexedDB cache unless you have a strong reason to replace it.

## Server-side indexes

For production, create:

```js
await db.collection("log").createIndex({ createdAt: 1, logId: 1 })
```

Add app indexes for list queries:

```js
await db.collection("order").createIndex({ status: 1, createdAt: -1 })
await db.collection("order").createIndex({ ownerId: 1, createdAt: -1 })
```

`idsRef({ filter, sort, skip, limit })` uses normal Mongo queries on the server, so app indexes matter.

## Force resync after migrations

After a bulk migration, clients may have stale cached documents. You can reset them:

```js
dbState.socket.broadcast({
  type: "dbstate:force_resync"
})
```

Clients reset `time1` and call `syncNow()`. Use this sparingly; it can replay a large log.

For very large migrations, prefer:

1. bump a cache version in your app;
2. call `state.clearLocalDB()` on next load;
3. login from a clean cache; reconnect sync will continue from the new cursor.

## Scaling broadcasts

For one Node process, the built-in socket hub is enough. For multiple processes or containers, `sync()` still reads from MongoDB correctly, but `changes_available` pings only reach sockets connected to the same process unless you add cross-process fan-out.

Use a Redis/NATS/etc adapter for outgoing broadcasts, and fan incoming messages out through your own local socket registry:

```js
const nodeId = crypto.randomUUID()

const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  socket: {
    broadcast(message, options) {
      pub.publish("db-state-bcast", JSON.stringify({ nodeId, message, options }))
    }
  }
})

await sub.subscribe("db-state-bcast", (raw) => {
  const { nodeId: fromNode, message, options } = JSON.parse(raw)
  if (fromNode === nodeId) return

  for (const client of localClients) {
    if (client.sessionId === options?.excludeSessionId) continue
    client.ws.send(JSON.stringify(message))
  }
})
```

Do not call `dbState.socket.broadcast()` from the subscription handler unless you also add a loop guard, because `broadcast()` calls the adapter again. For high-client deployments, combine cross-process fan-out with per-table subscription filtering so a write in one table does not wake every connected dashboard.
