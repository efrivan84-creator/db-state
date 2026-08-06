# Server setup

A working db-state server is about 15 lines of code. This page walks through every option you might care about.

## Minimal example

```js
import { WebSocketServer } from "ws"
import { MongoClient } from "mongodb"
import { createDbStateServer } from "@db-state/server-mongo"

const mongo = (await new MongoClient(process.env.MONGO_URI).connect()).db("myapp")

const dbState = createDbStateServer({
  mongo,
  tables: ["order", "product"]
})

new WebSocketServer({ port: 8788, path: "/db-state/ws" })
  .on("connection", (ws) => dbState.socket.addClient(ws))
```

The port and path belong to your WebSocket server, not to the Mongo/server config. You can
move them into env:

```js
const wsPort = Number(process.env.DB_STATE_WS_PORT ?? 8788)
const wsPath = process.env.DB_STATE_WS_PATH ?? "/db-state/ws"

new WebSocketServer({ port: wsPort, path: wsPath })
  .on("connection", (ws) => dbState.socket.addClient(ws))
```

This gives you:
- WebSocket RPC at `ws://host:8788/db-state/ws`
- CRUD methods: `load`, `getIds`, `getUnique`, `count`, `sync`, `update`, `add`, `remove`
- Auth via `dbstate:login` / `dbstate:auth` messages
- Append-only log in `log` collection
- Permission checks against group `access` objects (merged into `user.access` at login)

`tables` lists only tables exposed through the CRUD/RPC API. Service tables such as
`_user` and `_group` are not exposed automatically; list them explicitly
when an admin UI needs to read or edit them through db-state.

Set `servicePrefix`/`prefix` when you need several isolated db-state servers in one MongoDB database:

```js
const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  servicePrefix: "cfg"
})
```

With this prefix the service collections are `cfg_user`, `cfg_group`, and `cfg_log`.
Without a prefix the old defaults stay unchanged: `_user`, `_group`, `log`.
If clients need access to these tables, include the prefixed names in `tables`, for example
`["order", "cfg_user", "cfg_group", "cfg_log"]`.

It does **not** give you any seeded data — you must add a user and a group with an `access` object before clients can do anything (see below).

## Required Mongo indices

The library doesn't create indices automatically. For a healthy production server:

```js
await mongo.collection("log").createIndex({ createdAt: 1, logId: 1 })
```

With `servicePrefix: "cfg"`, create the same index on `cfg_log`.

The first index is critical — `sync` reads slices of the log ordered by these fields. Without it, sync becomes O(N) per call.

For tables you query frequently with filters, add Mongo indices like in any normal Mongo app:

```js
await mongo.collection("order").createIndex({ status: 1, createdAt: -1 })
```

`getIds`, `count`, `getUnique` all run `find(filter)` on Mongo directly.

## Seeding initial data

You need at least one user and one permission for anyone to do anything:

```js
import { defaultPassword } from "@db-state/server-mongo"

await mongo.collection("_user").updateOne(
  { _id: "u_admin" },
  {
    $setOnInsert: {
      _id: "u_admin",
      login: "admin",
      passwordHash: await defaultPassword.hash("change-me-on-first-login"),
      groups: ["admin"],
      disabled: false
    }
  },
  { upsert: true }
)

await mongo.collection("_group").updateOne(
  { _id: "admin" },
  { $set: { name: "Admins", access: { fullaccess: 1 } } },
  { upsert: true }
)
```

Rights live on groups as `access` objects — see [permissions.md](permissions.md).

## All `createDbStateServer` options

```js
createDbStateServer({
  mongo,                         // required: MongoDatabaseLike
  tables: ["order", "product"],  // required: app table names

  // Optional:
  hooks:            { ... },     // lifecycle hooks (see hooks.md)
  hooks:            { ... },     // before/after/error read/write lifecycle hooks
  password:         { hash, verify },  // password adapter (default: PBKDF2)
  createAuthHash:   () => string,      // default: 32 random bytes hex
  createLogId:      () => string,      // default: crypto.randomUUID()
  getUser:          async (ctx) => user, // resolve user from request
  servicePrefix:    "cfg",       // optional: cfg_user/cfg_group/cfg_log
  logCollection:    "log",       // log collection name
  groupTable:       "_group",
  userTable:        "_user",
  systemUserId:     "system",    // actor for internal writes without a user
  now:              () => new Date().toISOString(),  // server clock
  socket:           adapter      // out-of-process broadcast adapter
})
```

### `getUser`

By default, the library reads `req.client.user` (set by `dbstate:login` / `dbstate:auth` on the socket). Override to plug in your own auth:

```js
createDbStateServer({
  mongo,
  tables: [...],
  getUser: async ({ req, client }) => {
    if (req?.headers?.authorization) {
      return verifyJWT(req.headers.authorization)
    }
    return req?.client?.user
  }
})
```

This lets you accept both WebSocket-authenticated clients and HTTP JWT-authenticated clients (if you wrap RPCs in an HTTP endpoint).

### `now`

Useful for tests and reproducible demos:

```js
let frozen = "2026-01-01T00:00:00.000Z"
createDbStateServer({ mongo, tables, now: () => frozen })
// then in tests: frozen = "2026-01-02T00:00:00.000Z"
```

### Sync time windows

One `sync` response covers at most 12 hours of log time. When the client is further behind, the server returns `hasMore: true`; the Vue client immediately requests the next window until it catches up.

If the cursor is more than 20 days old, replay is refused with `reset: true`. The client discards its local cache, reloads active records and queries from the database, and resumes incremental sync from the returned `to`.

## WebSocket integration

The minimal example uses [`ws`](https://github.com/websockets/ws). The library is transport-agnostic — see [websocket-integration.md](websocket-integration.md) for `uWebSockets.js`, `fastify-websocket`, and custom adapters.

## Multi-process / multi-node

The default `SocketHub` only knows about clients in the same process. If you run multiple Node processes (cluster mode, multiple containers behind a load balancer), broadcasts won't reach clients on other processes.

Solutions:

1. **Sticky sessions + single broadcast process** — pin each client to one process via the load balancer. Broadcasts work within a process. Sync still works fine across processes (every client polls Mongo via sync).
2. **Custom broadcast adapter** — pass `socket: { broadcast }` that re-broadcasts via Redis pubsub / NATS / etc.

```js
import { randomUUID } from "crypto"
import { createClient } from "redis"

const sub = createClient({ url: "redis://..." })
const pub = createClient({ url: "redis://..." })
await Promise.all([sub.connect(), pub.connect()])

const nodeId = randomUUID()

createDbStateServer({
  mongo,
  tables: [...],
  socket: {
    broadcast: (message, options) => {
      pub.publish("db-state-broadcast", JSON.stringify({
        nodeId,
        message,
        options
      }))
    }
  }
})

await sub.subscribe("db-state-broadcast", (raw) => {
  const { nodeId: fromNode, message, options } = JSON.parse(raw)
  if (fromNode === nodeId) return

  // Fan out to local sockets through your own client registry.
  // Do not call dbState.socket.broadcast() here, because that would publish
  // back into Redis through the adapter and can create a loop.
  for (const client of localClients) {
    if (client.sessionId === options?.excludeSessionId) continue
    client.ws.send(JSON.stringify(message))
  }
})
```

For production, keep a tiny local client registry next to your WebSocket setup or wrap the WebSocket adapter in a class. The important rule is simple: outgoing library broadcasts go to Redis; incoming Redis messages fan out to local sockets without re-entering the library broadcast adapter.

## Adding HTTP endpoints

The core library only does WebSocket RPC. Official file transfer is handled by `@db-state/server-files` over the same WebSocket using `dbfile:*` control messages plus binary frames. If you need HTTP for other concerns (OAuth callbacks, public REST endpoints, curl-friendly health checks), add a separate HTTP server:

```js
import { createServer } from "http"
import { WebSocketServer } from "ws"
import express from "express"

const app = express()
app.get("/health", (_, res) => res.send("ok"))

const httpServer = createServer(app)
const wss = new WebSocketServer({ server: httpServer, path: "/db-state/ws" })
wss.on("connection", (ws) => dbState.socket.addClient(ws))

httpServer.listen(8788)
```

WebSocket and HTTP share the same port via the `server` option.

## TLS / WSS

In production, run behind a reverse proxy (nginx, Caddy, Traefik) that terminates TLS:

```
client ─wss──> Caddy ─ws──> Node
```

Caddy snippet:

```
example.com {
  reverse_proxy /db-state/ws ws://localhost:8788 {
    header_up Upgrade {http.request.header.upgrade}
    header_up Connection {http.request.header.connection}
  }
  reverse_proxy /* localhost:3000   # your Vue app
}
```

Most reverse proxies auto-detect WebSocket upgrades, but verify the headers are forwarded correctly — without them, the upgrade silently fails and the client retries forever.

## Logging

The library logs minimal output (nothing on success, errors to stderr via `console.error`). For observability:

```js
import { handleRpc as origHandleRpc, createHandlers } from "@db-state/server-mongo/rpc"

// Wrap your handlers for tracing:
const handlers = createHandlers(dbStateApi)
const traced = {}
for (const [method, fn] of Object.entries(handlers)) {
  traced[method] = async (req) => {
    const t0 = Date.now()
    try {
      const result = await fn(req)
      metrics.record("rpc.ok", method, Date.now() - t0)
      return result
    } catch (e) {
      metrics.record("rpc.error", method, Date.now() - t0)
      throw e
    }
  }
}
```

You'd then use the wrapped router with `handleRpc` directly. This requires a small amount of custom plumbing — see [api-reference.md](api-reference.md#custom-handlers).

## Stopping the server

```js
import { gracefulShutdown } from "./shutdown.js"

process.on("SIGTERM", async () => {
  await gracefulShutdown([wss, mongoClient])
  process.exit(0)
})
```

The library has no `dbState.close()` — there's nothing to clean up at the library level beyond closing the WebSocket server and the Mongo client. Open connections will drop and clients will auto-reconnect to the new instance.
