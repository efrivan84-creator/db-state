# WebSocket integration

> [English](../../en/server/websocket-integration.md) · **Русский**

db-state не создает HTTP server. Ты подключаешь его к своему WebSocket layer через `dbState.socket.addClient`.

## Option 1: `ws`

```js
import { WebSocketServer } from "ws"

const wss = new WebSocketServer({ port: 8788, path: "/db-state/ws" })

wss.on("connection", (ws, request) => {
  dbState.socket.addClient(ws)
})
```

Это рекомендуемый и самый простой вариант.

### Heartbeats

Добавь ping/pong, если proxy или сеть могут оставлять мертвые соединения:

```js
wss.on("connection", (ws) => {
  ws.isAlive = true
  ws.on("pong", () => { ws.isAlive = true })
  dbState.socket.addClient(ws)
})

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate()
    ws.isAlive = false
    ws.ping()
  }
}, 30000)
```

### Behind HTTP server

```js
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: "/db-state/ws" })
```

## Option 2: `uWebSockets.js`

Нужен adapter, который дает методы `send`, `close`, `on("message")`, `on("close")` в форме, понятной socket hub. Используй этот путь только если тебе реально нужна производительность uWS.

## Option 3: Fastify

С Fastify подход тот же: получи raw socket из websocket route и передай в `addClient` или напиши тонкий adapter.

## Option 4: Custom adapter

Минимальный socket должен уметь:

- отправлять string/binary frames;
- принимать message frames;
- сообщать close;
- закрываться.

Это позволяет использовать нестандартные runtimes.

## Connection metadata

```js
dbState.socket.addClient(ws, {
  user,
  userId: user._id,
  sessionId: "external-session"
})
```

Metadata полезна, если auth уже сделан в reverse proxy, cookie middleware или другом сервисе.

## Disposer

`addClient` возвращает disposer. Вызови его, если внешний framework сам управляет lifecycle и нужно явно убрать client из hub.

## Multi-process broadcasts

### Sticky sessions

WebSocket обычно требует sticky sessions на load balancer, чтобы соединение оставалось на одном Node-процессе.

### Redis pubsub adapter

Один процесс после write публикует wake-up в Redis, все процессы получают его и будят своих локальных clients:

```js
await redis.publish("db-state:wakeup", JSON.stringify({ type: "changes_available" }))
```

Не публикуй сами документы, только сигнал. Клиенты все равно выполнят `sync()` с permissions.

## Reverse proxy notes

Проверь:

- `Upgrade` и `Connection` headers;
- path `/db-state/ws`;
- idle timeout больше ожидаемого периода простоя;
- max frame/body limits для file module;
- sticky sessions, если несколько Node-процессов.

## TLS termination

Обычно браузер подключается по `wss://`, а Node слушает plain `ws://` за proxy. Главное, чтобы frontend `wsUrl` совпадал с публичным origin/path.
