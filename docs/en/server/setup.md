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

This gives you:
- WebSocket RPC at `ws://host:8788/db-state/ws`
- CRUD methods: `load`, `getIds`, `getUnique`, `count`, `sync`, `update`, `add`, `remove`
- Auth via `dbstate:login` / `dbstate:auth` messages
- Append-only log in `log` collection
- Permission checks against `_permission` collection

It does **not** give you any seeded data — you must add a user and at least one permission before clients can do anything (see below).

## Required Mongo indices

The library doesn't create indices automatically. For a healthy production server:

```js
await mongo.collection("log").createIndex({ createdAt: 1, logId: 1 })
await mongo.collection("_permission").createIndex({ table: 1, priority: -1 })
```

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

await mongo.collection("_permission").updateMany(
  {},
  {
    $setOnInsert: {
      _id: "perm_admin_all",
      table: "*",  // Actually no — you need one row PER table; see permissions.md
      priority: 100,
      read:  { groups: ["admin"] },
      write: { groups: ["admin"] }
    }
  },
  { upsert: true }
)
```

(The library doesn't support `table: "*"` wildcards — see [permissions.md](permissions.md). Add one rule per table.)

## All `createDbStateServer` options

```js
createDbStateServer({
  mongo,                         // required: MongoDatabaseLike
  tables: ["order", "product"],  // required: app table names

  // Optional:
  access:           { ... },     // code access rules (see code-access-rules.md)
  hooks:            { ... },     // before/after/error read/write lifecycle hooks
  password:         { hash, verify },  // password adapter (default: PBKDF2)
  createAuthHash:   () => string,      // default: 32 random bytes hex
  createLogId:      () => string,      // default: crypto.randomUUID()
  getUser:          async (ctx) => user, // resolve user from request
  logCollection:    "log",       // log collection name
  permissionTable:  "_permission",
  userTable:        "_user",
  systemUserId:     "system",    // actor for internal writes without a user
  now:              () => new Date().toISOString(),  // server clock
  syncLimit:        1000,        // max changes per sync call
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

### `syncLimit`

Maximum number of log entries returned in a single `sync` call. Default 1000. Lower it only if your log entries are very large and your write volume is low; raise it if you have a lot of small changes.

The current cursor is timestamp-based. A single sync response should fit all visible changes in its `(from, to]` window. For very busy systems, use a higher `syncLimit` or add cursor continuation by `{ createdAt, logId }` before relying on a small limit for long catch-up windows.

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
