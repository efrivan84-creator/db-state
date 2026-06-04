# Socket: custom events

> [English](../../en/client/socket.md) · **Русский**

db-state использует один WebSocket для своих RPC/auth/sync и для событий приложения. Зарезервирован только namespace `dbstate:*`; остальные event types можно использовать в своем протоколе.

## Reserved vs custom events

Не отправляй свои сообщения с prefix `dbstate:`. Он принадлежит библиотеке. Для приложения используй имена вроде:

```text
chat:typing
presence:update
game:move
notify:toast
```

Файловый модуль также использует `dbfile:*`.

## Отправка и прием

```js
state.socket.on("chat:typing", (message) => {
  console.log(message.payload)
})

state.socket.send("chat:typing", {
  roomId,
  userId: state.auth.userId
})
```

`send(type, payload)` дождется open socket и отправит JSON message.

## Wire format

```json
{
  "type": "chat:typing",
  "payload": {
    "roomId": "r1"
  }
}
```

## Server side

Если используешь `dbState.socket.addClient(ws)`, custom JSON messages без `dbstate:*` можно обработать через socket hub raw/custom hooks или рядом с adapter-обвязкой.

Пример broadcast:

```js
dbState.socket.broadcast({
  type: "notify:toast",
  payload: { text: "Order closed" }
})
```

### Отправить конкретному пользователю

Храни mapping `userId -> clients` в своем слое или фильтруй `dbState.socket.clients`, если используешь стандартный hub.

## Полезные паттерны

### Server-pushed notifications

Для UI-уведомлений не нужно писать строку в MongoDB:

```js
dbState.socket.broadcast({
  type: "notify:toast",
  payload: { level: "info", text: "Import finished" }
})
```

### Force resync

Для bulk migrations можно послать:

```js
dbState.socket.broadcast({ type: "dbstate:force_resync" })
```

Это системное событие, используй осторожно.

### Heartbeat / presence

Ephemeral presence лучше вести custom events:

```js
state.socket.send("presence:update", { status: "editing", docId })
```

Не пиши каждое движение курсора в MongoDB.

### Chat / realtime inputs

Сообщения, которые должны сохраняться и синхронизироваться после reload, храни через `state.message.add()`. Индикаторы "печатает" и live cursors отправляй custom events.

## Lifecycle events

Клиент может слушать:

```js
state.socket.on("dbstate:socket_open", () => {})
state.socket.on("dbstate:socket_close", () => {})
state.socket.on("dbstate:hello", () => {})
state.socket.on("dbstate:changes_available", () => {})
```

RPC envelopes тоже эмитятся для диагностики:

```js
state.socket.on("dbstate:rpc_result", (message) => {})
state.socket.on("dbstate:rpc_error", (message) => {})
```

## Raw WebSocket access

```js
const raw = state.socket.raw
```

Используй raw socket только для интеграций, где facade недостаточно. Для обычных JSON events безопаснее `state.socket.send/on`.

## Закрытие

```js
state.socket.raw?.close()
```

После close клиент может перейти в restored/anonymous state в зависимости от saved credentials. Для нормального logout используй `state.logout()`.
