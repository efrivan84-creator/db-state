# Socket: custom events

The same WebSocket the library uses for sync is **available to your app** for custom events. No second connection, no second protocol — just don't use the reserved `dbstate:*` namespace.

## Reserved vs. custom events

| Namespace | Owned by | Examples |
|---|---|---|
| `dbstate:*` | The library | `dbstate:rpc`, `dbstate:login_result`, `dbstate:changes_available` |
| Anything else | Your app | `auth:expired`, `chat:message`, `presence:online`, `client:ready` |

If you try to `send("dbstate:something", ...)` from the client, the library throws to prevent accidental collisions.

## Sending and receiving

```js
// On the client
state.socket.on("chat:message", (msg) => {
  console.log("got chat message:", msg)
})

state.socket.send("chat:message", { text: "hello", room: "general" })
```

The handler signature:

```ts
(message: { type: string; [key: string]: unknown }) => void
```

The returned value from `on()` is a disposer:

```js
const off = state.socket.on("chat:message", handler)
// later:
off()
```

## Wire format

Custom events go over the wire as:

```json
{ "type": "chat:message", "payload": { "text": "hello", "room": "general" } }
```

System events use different shapes (e.g. RPC has `id`, `method`, `payload` fields). The client routes `dbstate:rpc_result` / `dbstate:rpc_error` internally — your handler will never see them.

## Server side

The library's `SocketHub` doesn't dispatch custom events automatically. You handle them in your own dispatcher:

```js
import { WebSocketServer } from "ws"
import { createDbStateServer } from "@db-state/server-mongo"

const dbState = createDbStateServer({ mongo, tables: [...] })

const wss = new WebSocketServer({ port: 8788, path: "/db-state/ws" })

wss.on("connection", (ws) => {
  dbState.socket.addClient(ws)

  // Custom dispatcher for app events:
  ws.on("message", (raw) => {
    let msg
    try { msg = JSON.parse(String(raw)) } catch { return }

    if (msg.type === "chat:message") {
      handleChatMessage(ws, msg.payload)
    }
  })
})
```

The library's own message handler is already attached by `addClient`. Your handler runs in parallel and only acts on the types it cares about (`dbstate:*` is silently ignored by your code since you don't match it).

### Broadcast a custom event from the server

The `socket` hub exposes `broadcast`:

```js
dbState.socket.broadcast(
  { type: "presence:online", payload: { userId: "u_123" } },
  { excludeSessionId: originatingSessionId }   // optional
)
```

All connected clients (except the one matching `excludeSessionId`) receive it. They handle it via `state.socket.on("presence:online", ...)`.

### Send to a specific user

```js
dbState.socket.sendToUser("u_123", "notification:new", { text: "Order ready" })
```

The hub finds every client with `userId === "u_123"` and sends the message. Note: only the **first** auth'd `userId` on each socket counts — if a socket isn't authenticated, it won't receive.

## Useful patterns

### Server-pushed notifications

Server side — after some background job:

```js
dbState.socket.sendToUser(userId, "notification:new", {
  id: notifId,
  text: "Your export is ready",
  url: "/exports/" + notifId
})
```

Client:

```js
state.socket.on("notification:new", (msg) => {
  notifications.value.push(msg.payload)
})
```

### Server-pushed force-resync

Useful after a heavy admin operation (e.g. bulk import). Tell every client to discard `time1` and resync from scratch:

```js
// Server
dbState.socket.broadcast({ type: "dbstate:force_resync" })
```

The library handles this internally — clients reset `time1` and run `syncNow`. Use sparingly; it's an O(N) sync on every client.

### Heartbeat / presence

Client:

```js
setInterval(() => {
  if (state.sync.connected) {
    state.socket.send("presence:heartbeat", { now: Date.now() })
  }
}, 30_000)
```

Server:

```js
const lastSeen = new Map()  // userId -> timestamp

wss.on("connection", (ws) => {
  dbState.socket.addClient(ws)
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw))
    if (msg.type === "presence:heartbeat" && ws.userId) {
      lastSeen.set(ws.userId, Date.now())
    }
  })
})
```

### Chat / real-time inputs

For app-level chat or presence, the WebSocket is already there. No need to add socket.io or another library — just define your own event protocol on top.

```js
// Client A sends:
state.socket.send("chat:typing", { room: "general" })

// Server fans out:
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.type === "chat:typing") {
    dbState.socket.broadcast(
      { type: "chat:typing", payload: { ...msg.payload, by: ws.userId } },
      { excludeSessionId: ws.sessionId }
    )
  }
})

// All other clients hear:
state.socket.on("chat:typing", (msg) => {
  showTypingIndicator(msg.payload.by, msg.payload.room)
})
```

## Lifecycle events

```js
state.socket.on("dbstate:socket_open", () => {
  console.log("connected")
})

state.socket.on("dbstate:socket_close", () => {
  console.log("disconnected — auto-reconnect in", options.reconnectDelay, "ms")
})
```

These are emitted by the library itself — synthetic events around the underlying WebSocket open/close. Useful for showing connection status in the UI.

```js
state.socket.on(DB_STATE_EVENTS.hello, () => {
  // First message from the server after a fresh connection.
  // Sent before any RPCs are accepted.
})

state.socket.on(DB_STATE_EVENTS.changesAvailable, () => {
  // Server has new changes for at least one table.
  // The library is about to call syncNow automatically.
})
```

You can subscribe to these for telemetry, but don't try to drive sync from your code — the library does it.

## Raw WebSocket access

If you need something the facade doesn't expose:

```js
const ws = state.socket.raw  // WebSocket | undefined

if (ws?.readyState === WebSocket.OPEN) {
  ws.send(/* anything */)
}
```

Useful for diagnostics. Don't use it to bypass the library's protocol — sending custom `dbstate:*` events directly may break the internal state machine.

## Closing

The library auto-reconnects with a constant delay (`reconnectDelay`, default 1s). There is no "graceful close" API — for a clean shutdown, just stop using `state` and let GC collect it. The socket will close when the tab does.
