# WebSocket integration

`@db-state/server-mongo` is transport-agnostic. It only needs:

- An object with `send(string)` per client (for outgoing messages).
- An `on("message", handler)` per client (for incoming).

Any WebSocket library that exposes these works. This page shows three popular options and one custom adapter.

## Option 1: `ws` (recommended)

Most stable, most widely deployed. The minimal example everywhere in these docs.

```sh
npm install ws
```

```js
import { WebSocketServer } from "ws"

const wss = new WebSocketServer({
  port: 8788,
  path: "/db-state/ws"
})

wss.on("connection", (ws) => {
  dbState.socket.addClient(ws)
})
```

`ws` instances have `send(string)` and emit `"message"` events with `Buffer` data — the library handles `String(buffer)` parsing internally.

### Heartbeats

`ws` doesn't ping by default. For long-lived connections behind aggressive idle timeouts (e.g. AWS ALB, Cloudflare), enable ping:

```js
import { WebSocketServer } from "ws"

const wss = new WebSocketServer({ port: 8788, path: "/db-state/ws" })

function heartbeat() { this.isAlive = true }

wss.on("connection", (ws) => {
  ws.isAlive = true
  ws.on("pong", heartbeat)
  dbState.socket.addClient(ws)
})

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate()
    ws.isAlive = false
    ws.ping()
  })
}, 30_000)
```

### Behind an HTTP server

To share a port with a normal HTTP server (e.g. express, fastify):

```js
import { createServer } from "http"
import express from "express"

const app = express()
app.get("/health", (_, res) => res.send("ok"))

const server = createServer(app)
const wss = new WebSocketServer({ server, path: "/db-state/ws" })

wss.on("connection", (ws) => dbState.socket.addClient(ws))

server.listen(8788)
```

The `path` option ensures only `/db-state/ws` requests upgrade — other requests fall through to express.

## Option 2: `uWebSockets.js`

Higher throughput, more memory-efficient than `ws`. Recommended if you have 10k+ concurrent connections.

```sh
npm install uWebSockets.js
```

```js
import uWS from "uWebSockets.js"

uWS.App()
  .ws("/db-state/ws", {
    open: (ws) => {
      // Adapt uWS interface to what the library expects:
      const adapter = {
        send: (str) => ws.send(str),
        on: (event, handler) => {
          if (event === "message") ws._messageHandler = handler
        }
      }
      ws.adapter = adapter
      dbState.socket.addClient(adapter)
    },
    message: (ws, message, isBinary) => {
      const text = Buffer.from(message).toString()
      ws.adapter._messageHandler?.(text)
    },
    close: (ws) => {
      // The library uses Set membership for clients; closure is detected when
      // ws.send fails next time. If you want explicit cleanup:
      // store the disposer returned by addClient and call it here.
    }
  })
  .listen(8788, (listenSocket) => {
    if (listenSocket) console.log("uWS on 8788")
  })
```

Note: `uWebSockets.js` exposes a non-standard API. The adapter above bridges to the library's `{ send, on }` shape. For a cleaner approach, wrap it in a class.

## Option 3: `fastify-websocket`

If your stack already uses Fastify:

```sh
npm install fastify @fastify/websocket
```

```js
import Fastify from "fastify"
import websocket from "@fastify/websocket"

const fastify = Fastify()
await fastify.register(websocket)

fastify.get("/db-state/ws", { websocket: true }, (connection) => {
  dbState.socket.addClient(connection.socket)
})

await fastify.listen({ port: 8788 })
```

`connection.socket` is a `ws` instance under the hood, so the integration is trivial.

## Option 4: Custom adapter

Any object satisfying this interface works:

```ts
interface SocketClient {
  send?(raw: string): void
  on?(event: "message", listener: (raw: unknown) => void): void
}
```

For a tests/mock client:

```js
class MockClient {
  constructor() {
    this.sent = []
    this.listeners = []
  }
  send(raw) { this.sent.push(raw) }
  on(event, fn) {
    if (event === "message") this.listeners.push(fn)
  }
  receive(raw) {
    for (const fn of this.listeners) fn(raw)
  }
}

const client = new MockClient()
dbState.socket.addClient(client)

client.receive(JSON.stringify({ type: "dbstate:login", id: "1", login: "admin", password: "..." }))
console.log(client.sent[1])  // dbstate:login_result
```

This is what [test/server-mongo.test.js](../../../test/server-mongo.test.js) uses for unit tests.

## Connection metadata

`addClient(ws, meta)` accepts an optional meta object:

```js
dbState.socket.addClient(ws, {
  user: { _id: "u_123", login: "admin", groups: ["admin"] },
  userId: "u_123",
  sessionId: "u_123_abcdef"
})
```

Use this when you've authenticated the connection outside of `dbstate:login` (e.g. JWT in URL query — see [authentication.md](authentication.md#custom-auth-bypassing-dbstatelogin)).

Without meta, the client starts anonymous and must send `dbstate:login` or `dbstate:auth` before any RPCs.

## The disposer

`addClient` returns a disposer:

```js
const detach = dbState.socket.addClient(ws)

ws.on("close", () => detach())
```

This removes the client from the broadcast set. Most apps don't need it — when `ws.send` fails on a dead socket, the library catches and ignores. But for tidy resource tracking, call `detach()` on close.

## Multi-process broadcasts

`SocketHub.broadcast` only fans out to clients in the same Node process. For multi-process deployments:

### Sticky sessions

Pin each client to one Node process via your load balancer (`ip_hash` in nginx, `client_ip` in HAProxy). Each process broadcasts locally. Sync still works across processes — `sync()` reads from Mongo, which is shared.

### Redis pubsub adapter

```js
import { createClient } from "redis"

const pub = createClient({ url: "redis://localhost" })
const sub = createClient({ url: "redis://localhost" })
await Promise.all([pub.connect(), sub.connect()])

// Outgoing: re-publish every broadcast to Redis.
const adapter = {
  broadcast: (msg) => {
    pub.publish("db-state-bcast", JSON.stringify(msg))
  }
}

const dbState = createDbStateServer({
  mongo,
  tables: [...],
  socket: adapter
})

// Incoming: re-fan-out received messages to local clients.
await sub.subscribe("db-state-bcast", (raw) => {
  const msg = JSON.parse(raw)
  // Fan out to local clients, but skip our adapter to avoid a loop.
  // Trick: the library's broadcast also calls adapter.broadcast — so we need a flag.
  // Simplest: emit the message directly via a separate path.
  for (const c of localClients) c.send(JSON.stringify(msg))
})
```

The library's current `broadcast` runs `adapter.broadcast` then iterates local clients. For Redis-style loops, you may need to track origin sessions or attach a unique broadcast id and dedup. See [advanced patterns](../cookbook/advanced-patterns.md#scaling-broadcasts) for a fuller pattern.

## Reverse proxy notes

The library doesn't speak HTTP, only WebSocket frames. Your reverse proxy must:

1. Recognize the WebSocket upgrade (`Connection: Upgrade`, `Upgrade: websocket` headers).
2. Forward the upgrade to the Node process.
3. Keep the connection open (no idle timeouts shorter than your ping interval).

Caddy auto-detects WebSockets. Nginx needs explicit config:

```nginx
location /db-state/ws {
  proxy_pass http://localhost:8788;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "Upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 3600s;        # 1h idle
}
```

`proxy_read_timeout 3600s` matters — without it, nginx closes the connection after 60 seconds of inactivity, and clients reconnect constantly. Pair with a 30-second client/server ping.

## TLS termination

Run TLS at the proxy:

```
client ─wss──> Caddy/Nginx ─ws──> Node
```

This way Node never sees a TLS handshake — simpler, faster, and lets you reload certs without restarting the app.

For direct TLS at Node (less common):

```js
import { createServer } from "https"
import { readFileSync } from "fs"

const server = createServer({
  cert: readFileSync("./fullchain.pem"),
  key:  readFileSync("./privkey.pem")
})
const wss = new WebSocketServer({ server, path: "/db-state/ws" })

wss.on("connection", (ws) => dbState.socket.addClient(ws))
server.listen(8788)
```
