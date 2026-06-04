# Быстрый старт

> [English](../en/getting-started.md) · **Русский**

Эта страница показывает минимальную связку: Node-сервер с MongoDB и Vue-клиент, который читает и меняет документы как реактивное состояние.

## Что получится

После настройки `state.order.load("o1")` вернет reactive object, `listRef()` даст живой список, а `update()` запишет изменение в MongoDB, append-only log и разошлет sync другим клиентам.

## Требования

- Node.js 20+.
- Vue 3 на клиенте.
- MongoDB или совместимый объект для тестов.
- WebSocket server, обычно пакет `ws`.

## Установка

```sh
# В Vue-приложении
npm install @db-state/vue

# На Node-сервере
npm install @db-state/server-mongo mongodb ws
```

## Сервер (Node)

```js
import { WebSocketServer } from "ws"
import { MongoClient } from "mongodb"
import { createDbStateServer, defaultPassword } from "@db-state/server-mongo"

const mongo = (await new MongoClient(process.env.MONGO_URI).connect()).db("app")

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

await mongo.collection("log").createIndex({ createdAt: 1, logId: 1 })
await mongo.collection("_permission").createIndex({ table: 1, priority: -1 })
await mongo.collection("order").createIndex({ status: 1, createdAt: -1 })

const dbState = createDbStateServer({
  mongo,
  tables: ["order"]
})

new WebSocketServer({ port: 8788, path: "/db-state/ws" })
  .on("connection", (ws) => dbState.socket.addClient(ws))
```

`_user`, `_group` и `_permission` добавляются к списку таблиц автоматически. Но доступ все равно deny-by-default, поэтому для чтения и записи нужны permissions или code access rules.

## Клиент (Vue 3)

```js
// src/state.js
import { createDbState } from "@db-state/vue"

export const state = createDbState({
  tables: ["order"],
  wsUrl: "ws://127.0.0.1:8788/db-state/ws"
})
```

```vue
<script setup>
import { computed, ref } from "vue"
import { state } from "./state"

const login = ref("admin")
const password = ref("admin")
const loading = state.getKeyRef("orders")

const orders = state.order.listRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  limit: 50
}, "orders")

const openCount = state.order.countRef({ status: "open" })
const isReady = computed(() => state.auth.status === "authorized")

async function signIn() {
  await state.login(login.value, password.value)
}

async function closeOrder(order) {
  await state.order.update({
    id: order._id,
    set: { status: "closed" }
  }, "orders")
}
</script>

<template>
  <button v-if="!isReady" @click="signIn">Войти</button>

  <template v-else>
    <p v-if="loading.value > 0">Загрузка {{ loading.percent }}%</p>
    <p>Открытых заказов: {{ openCount }}</p>

    <button
      v-for="order in orders"
      :key="order._id"
      @click="closeOrder(order)"
    >
      {{ order._id }} - {{ order.status }}
    </button>
  </template>
</template>
```

## Что уже есть из коробки

- Реактивные документы через `load(id, key?)`.
- Реактивные списки и счетчики через `listRef`, `idsRef`, `countRef`.
- Cache-first чтение из IndexedDB.
- WebSocket RPC для чтения, записи, логина и sync.
- Append-only log для аудита и восстановления.
- Права на уровне таблиц и полей.
- Автоматический refresh query refs после локальных и удаленных изменений.

## Следующие шаги

- Разобраться с [реактивными запросами](client/reactive-queries.md).
- Настроить [права доступа](server/permissions.md).
- Прочитать [sync protocol](architecture/sync-protocol.md), если нужно отлаживать realtime.
- Для файлов подключить [file modules](files.md).
