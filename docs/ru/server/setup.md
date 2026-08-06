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

Порт и path относятся к твоему WebSocket server, а не к Mongo/server config. Их можно
вынести в env:

```js
const wsPort = Number(process.env.DB_STATE_WS_PORT ?? 8788)
const wsPath = process.env.DB_STATE_WS_PATH ?? "/db-state/ws"

new WebSocketServer({ port: wsPort, path: wsPath })
  .on("connection", (ws) => dbState.socket.addClient(ws))
```

`tables` содержит только таблицы, которые нужно открыть через CRUD/RPC API. Служебные таблицы
`_user` и `_group` не добавляются автоматически: укажи их явно, если админке
нужно читать или редактировать их через db-state.

Если нужно поднять несколько независимых db-state серверов в одной MongoDB database,
задай `servicePrefix`/`prefix`:

```js
const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  servicePrefix: "cfg"
})
```

Тогда служебные коллекции будут `cfg_user`, `cfg_group`, а log — `cfg_log`.
Без prefix сохраняются старые имена: `_user`, `_group`, `log`.
Если эти таблицы нужно открыть клиенту, добавь prefixed имена в `tables`, например
`["order", "cfg_user", "cfg_group", "cfg_log"]`.

## Обязательные индексы MongoDB

```js
await mongo.collection("log").createIndex({ createdAt: 1, logId: 1 })
```

С `servicePrefix: "cfg"` используй соответственно `cfg_log`.

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

await mongo.collection("_group").updateOne(
  { _id: "admin" },
  { $set: { name: "Admins", access: { fullaccess: 1 } } },
  { upsert: true }
)
```

## Options `createDbStateServer`

| Option | Default | Значение |
|---|---:|---|
| `mongo` | required | Mongo database-like object. |
| `tables` | required | Прикладные таблицы. |
| `hooks` | `{}` | Хуки жизненного цикла; `before*` могут разрешить или запретить. См. [hooks.md](hooks.md). |
| `socket` | `{}` | Socket hub options. |
| `password` | PBKDF2 adapter | Password hasher/verifier. |
| `servicePrefix` / `prefix` | unset | Prefix для служебных коллекций: `cfg_user`, `cfg_group`, `cfg_log`. |
| `logCollection` | `"log"` | Имя log-коллекции; переопределяет prefix для log. |
| `userTable` | `"_user"` | Имя таблицы пользователей; переопределяет prefix для users. |
| `groupTable` | `"_group"` | Имя таблицы групп; переопределяет prefix для groups. |
| `now` | `new Date().toISOString()` | Server clock. |
| `id` | random id | Generator для log/doc ids. |
| `numericIds` | `false` | Числовые `_id` по порядку вместо uuid: `true` — для всех таблиц, массив — только для перечисленных. См. ниже. |
| `counterCollection` | `"_counter"` | Коллекция счётчиков для `numericIds`; подчиняется prefix (`cfg_counter`). |
| `systemUserId` | `"system"` | Actor id для внутренних writes без user. |
| `files` | `[]` | File modules. |

### `getUser`

По умолчанию сервер берет пользователя из socket client metadata. Если интегрируешь внешний auth, передай `getUser(req)` или добавь `user` в `addClient`.

### `numericIds`

По умолчанию новый документ получает uuid. `numericIds` заменяет его на номер
по порядку — 1, 2, 3:

```js
createDbStateServer({
  mongo,
  tables: ["order", "bill"],
  numericIds: true            // или список: ["order", "bill"]
})
```

Номера хранятся в коллекции `_counter` — один документ на таблицу,
`{ _id: "order", seq: 17 }`. Следующий номер берётся атомарным `$inc`, поэтому
одинаковых номеров не будет даже при одновременных запросах и из разных
процессов. Нумерация у каждой таблицы своя.

`_id`, присланный клиентом, используется как есть и счётчик не трогает — так
переносятся существующие записи с готовыми ключами.

Что учитывать:

- **Пропуски в нумерации нормальны.** Номер выдаётся до вставки; если запись не
  сохранится или её удалят, номер уже потрачен. Гарантии «без дыр» нет.
- **`_counter` — часть данных.** Потеряется при переносе базы — нумерация
  начнётся с единицы и наложится на существующие документы. Переносите вместе с
  коллекциями.
- **Наполняя базу вручную, выставляйте счётчик.** После импорта заявок с
  `_id: 1..500` документ счётчика должен быть `{ _id: "zad", seq: 500 }`.
- **+1 запрос к базе на создание.** Только на `add`; чтение и обновление не
  затрагиваются.

Имя коллекции меняется опцией `counterCollection` и подчиняется `prefix`:
с `prefix: "admin"` это `admin_counter`.

**Тип `_id` сохраняется на клиенте.** Vue-клиент приводит id к строке только
как ключ (ключи объектов и кэша всё равно строки), а на сервер и в само
поле `_id` документа уходит исходное значение. Строка `"1"` не совпала бы в
Mongo с числом `1`, поэтому `load(1)` отправляет число. В шаблонах учитывайте
это при строгом сравнении: `row._id === 1`, а не `=== "1"`.

### `now`

Подставляй deterministic clock в тестах. В production все процессы должны иметь согласованные часы.

### Временные окна sync

Один ответ `sync` покрывает не более 12 часов журнала. Если клиент отстал сильнее, сервер возвращает `hasMore: true`, а Vue-клиент сразу запрашивает следующее окно.

Если cursor старше 20 дней, сервер возвращает `reset: true`: клиент удаляет локальный cache, заново загружает активные объекты и query refs и продолжает sync от полученного `to`.

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
