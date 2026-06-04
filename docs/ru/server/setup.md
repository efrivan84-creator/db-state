# Настройка сервера

> [English](../../en/server/setup.md) · **Русский**

`@db-state/server-mongo` подключается к существующему Node-приложению и WebSocket server. HTTP endpoints пакет не создает.

## Минимальный пример

```js
import { WebSocketServer } from "ws"
import { MongoClient } from "mongodb"
import { createDbStateServer } from "@db-state/server-mongo"

const mongo = (await new MongoClient(process.env.MONGO_URI).connect()).db("app")

const dbState = createDbStateServer({
  mongo,
  tables: ["user", "order", "product"]
})

new WebSocketServer({ port: 8788, path: "/db-state/ws" })
  .on("connection", (ws) => dbState.socket.addClient(ws))
```

`tables` содержит только прикладные таблицы. `_user`, `_group` и `_permission` добавляются автоматически.

## Обязательные индексы MongoDB

```js
await mongo.collection("log").createIndex({ createdAt: 1, logId: 1 })
await mongo.collection("_permission").createIndex({ table: 1, priority: -1 })
```

Для прикладных запросов добавляй обычные Mongo indexes под свои filters/sorts:

```js
await mongo.collection("order").createIndex({ status: 1, createdAt: -1 })
```

## Seed начальных данных

Минимально нужен пользователь и права:

```js
import { defaultPassword } from "@db-state/server-mongo"

await mongo.collection("_user").updateOne(
  { _id: "u_admin" },
  {
    $set: {
      login: "admin",
      passwordHash: await defaultPassword.hash("admin"),
      groups: ["admin"],
      disabled: false
    }
  },
  { upsert: true }
)

await mongo.collection("_permission").updateOne(
  { _id: "perm_admin_order" },
  {
    $set: {
      table: "order",
      priority: 10,
      read: { groups: ["admin"], action: true },
      write: { groups: ["admin"], action: true }
    }
  },
  { upsert: true }
)
```

## Options `createDbStateServer`

| Option | Default | Значение |
|---|---:|---|
| `mongo` | required | Mongo database-like object. |
| `tables` | required | Прикладные таблицы. |
| `access` | `{}` | Code access rules. |
| `hooks` | `{}` | Lifecycle hooks. |
| `socket` | `{}` | Socket hub options. |
| `password` | PBKDF2 adapter | Password hasher/verifier. |
| `now` | `new Date().toISOString()` | Server clock. |
| `id` | random id | Generator для log/doc ids. |
| `syncLimit` | `1000` | Максимум changes за sync. |
| `systemUserId` | `"system"` | Actor id для внутренних writes без user. |
| `files` | `[]` | File modules. |

### `getUser`

По умолчанию сервер берет пользователя из socket client metadata. Если интегрируешь внешний auth, передай `getUser(req)` или добавь `user` в `addClient`.

### `now`

Подставляй deterministic clock в тестах. В production все процессы должны иметь согласованные часы.

### `syncLimit`

Должен покрывать одно sync window. Для high-write workloads добавь continuation по `{ createdAt, logId }`.

## WebSocket integration

Базовый путь:

```js
wss.on("connection", (ws, request) => {
  dbState.socket.addClient(ws)
})
```

Если внешний middleware уже аутентифицировал пользователя:

```js
dbState.socket.addClient(ws, {
  user,
  userId: user._id,
  sessionId
})
```

## Multi-process / multi-node

В одном процессе стандартный hub сам держит clients и broadcast. Для нескольких процессов нужен общий wake-up слой: Redis pubsub, NATS, Postgres notify или свой adapter. Важно, чтобы каждый процесс при Mongo write будил клиентов в остальных процессах.

## HTTP endpoints

db-state не запрещает HTTP. Держи рядом обычный Express/Fastify server для:

- health checks;
- OAuth callbacks;
- публичных downloads;
- domain actions, если они не должны идти по db-state RPC.

## TLS / WSS

В production обычно TLS завершается на reverse proxy:

```text
browser wss://app.example.com/db-state/ws
  -> nginx/caddy/cloud load balancer
  -> node ws://127.0.0.1:8788/db-state/ws
```

Проверь proxy headers и WebSocket upgrade.

## Логирование

Логируй auth failures, RPC errors, hook errors и slow sync. Не логируй пароли, auth hash и file tokens.

## Остановка сервера

При graceful shutdown:

1. Останови прием новых HTTP/WebSocket connections.
2. Закрой WebSocket server.
3. Дай активным RPC завершиться или оборви их по timeout.
4. Закрой MongoClient.
