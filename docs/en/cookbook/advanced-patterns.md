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

Use `_permission.if` when the tenant is a document field:

```js
{
  _id: "perm_order_t1_manager",
  table: "order",
  priority: 100,
  if: { tenantId: "t1" },
  read: { groups: ["t1_manager"] },
  write: { groups: ["t1_manager"], fields: ["status", "comment"] }
}
```

For many tenants, code access rules are often cleaner than generating thousands of permission rows:

```js
const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  access: {
    table: {
      order: {
        read: async ({ user, loadDoc }) => {
          const doc = await loadDoc()
          return user.tenantIds?.includes(doc?.tenantId)
        },
        write: async ({ user, action, loadDoc }) => {
          if (action === "insert") return true
          const doc = await loadDoc()
          return user.tenantIds?.includes(doc?.tenantId)
        }
      }
    }
  }
})
```

`loadDoc()` is lazy during sync. If the rule does not call it, Mongo is not queried for the changed document.

## Owner-based permissions

Example: users can read only their own tasks, admins can read all:

```js
access: {
  table: {
    task: {
      read: async ({ user, loadDoc }) => {
        if (user.groups?.includes("admin")) return true
        const task = await loadDoc()
        return task?.ownerId === user._id
      },
      write: async ({ user, action, loadDoc }) => {
        if (user.groups?.includes("admin")) return true
        if (action === "insert") return true

        const task = await loadDoc()
        return task?.ownerId === user._id
      }
    }
  }
}
```

Return `undefined` when you want `_permission` rules to decide instead:

```js
read: async ({ user }) => {
  if (user.disabled) return false
  return undefined
}
```

## Custom loading indicators

`getKeyRef(key)` lets a page group loads under a name:

```js
const loading = state.getKeyRef("orders-page")
const orders = state.order.listRef({ sort: { createdAt: -1 } }, "orders-page")
const user = state._user.load(state.auth.userId, "orders-page")
```

In Vue:

```vue
<div v-if="loading > 0">Loading...</div>
<OrderTable v-else :rows="orders" />
```

The key counts pending loads for all calls that use it.

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
await db.collection("_permission").createIndex({ table: 1, priority: -1 })
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
3. login/sync from a clean cache.

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
