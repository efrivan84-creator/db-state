import { WebSocketServer } from "ws"

import { accessAllows, createDbStateServer } from "@db-state/server-mongo"
import { createMemoryMongo } from "./memoryMongo.js"

const port = Number(process.env.DB_STATE_DEMO_PORT ?? 8787)

const mongo = createMemoryMongo({
  _user: [
    {
      _id: "u_admin",
      login: "admin",
      passwordHash: "demo:admin",
      groups: ["admin"],
      disabled: false
    },
    {
      _id: "u_manager",
      login: "manager",
      passwordHash: "demo:manager",
      groups: ["manager"],
      disabled: false
    }
  ],
  _group: [
    {
      _id: "admin",
      name: "Руководитель",
      access: { order: { read: {}, write: {} } }
    },
    {
      _id: "manager",
      name: "Менеджер",
      access: {
        order: {
          // Читает все заказы, но не все поля: маржу не видит.
          read: {},
          read_fields: ["number", "status", "client", "total", "comment", "ownerId"],
          // Писать может только в свои заказы: фильтр уходит в запрос к базе.
          // Для add он проверяется по новому документу, для update и
          // remove — по существующему.
          write: { ownerId: "$adminid" },
          write_fields: ["number", "status", "client", "total", "comment", "ownerId"]
        }
      }
    }
  ],
  order: [
    {
      _id: "o1",
      number: 1001,
      status: "новый",
      client: "ООО Ромашка",
      total: 1200,
      comment: "Позвонить до обеда",
      margin: 340,
      ownerId: "u_manager"
    },
    {
      _id: "o2",
      number: 1002,
      status: "в архиве",
      client: "ИП Петров",
      total: 500,
      comment: "Закрыт в прошлом году",
      margin: 90,
      ownerId: "u_manager"
    },
    {
      _id: "o3",
      number: 1003,
      status: "в работе",
      client: "ООО Ромашка",
      total: 8400,
      comment: "Ждём предоплату",
      margin: 1500,
      ownerId: "u_admin"
    },
    {
      _id: "o4",
      number: 1004,
      status: "новый",
      client: "АО Вектор",
      total: 3100,
      comment: "",
      margin: 620,
      ownerId: "u_admin"
    }
  ]
})

const dbState = createDbStateServer({
  mongo,
  tables: ["order"],

  // Права целиком в access групп (см. _group выше): руководитель видит и
  // правит всё, менеджер читает все заказы без поля margin, а пишет только
  // в свои — фильтр { ownerId: "$adminid" } уходит прямо в запрос к базе.
  //
  // Хуки — для того, что фильтром не выразить. Каждый объявляется один раз
  // на весь сервер, таблица разбирается внутри по ctx.table.
  hooks: {
    beforeRead: (ctx) => {
      if (ctx.table !== "order") return

      // Потолок выборки для всех, включая руководителя.
      if (ctx.method === "getIds") ctx.limit = Math.min(ctx.limit || 50, 50)

      // Динамическое сужение полей: ctx.fields уходит в projection запроса.
      // Сузить можно, расширить сверх read_fields группы — нет.
      if (ctx.method === "load" && !ctx.user.groups.includes("admin")) {
        ctx.fields = ["number", "status", "client", "total", "comment", "ownerId"]
      }

      // Ничего не вернули → дальше решает access группы.
    },

    beforeWrite: (ctx) => {
      if (ctx.table !== "order") return

      // Архивный заказ не правит никто, даже руководитель: запрет из хука
      // сильнее прав группы.
      if (ctx.old?.status === "в архиве") {
        return { allowed: false, reason: "Архивный заказ изменять нельзя" }
      }

      // Нормализуем статус до записи.
      if (ctx.method === "update" && typeof ctx.set.status === "string") {
        ctx.set.status = ctx.set.status.trim().toLowerCase()
      }
    },

    afterWrite: (ctx) => {
      // Точка для аудита: запись уже в базе и в журнале, запретить нельзя.
      console.log(`[аудит] ${ctx.actorId} ${ctx.method} ${ctx.table}/${ctx.id}`)
    },

    errorWrite: (ctx) => {
      console.warn(`[отказ] ${ctx.method} ${ctx.table}: ${ctx.error.message}`)
    }
  },

  // Именованный RPC-метод: своя серверная команда рядом со стандартным CRUD.
  // Права проверяет сам — встроенные проверки на него не распространяются.
  methods: {
    "order.next-number": async ({ client }) => {
      if (!accessAllows(client?.user?.access, "order", "write")) {
        throw new Error("Недостаточно прав для выдачи номера")
      }

      const [last] = await mongo.collection("order").find({}).sort({ number: -1 }).limit(1).toArray()
      return { number: (last?.number ?? 1000) + 1 }
    }
  },

  password: {
    hash: async (password) => `demo:${password}`,
    verify: async (password, passwordHash) => passwordHash === `demo:${password}`
  }
})

const wss = new WebSocketServer({ port, path: "/db-state/ws" })

wss.on("connection", (ws) => {
  dbState.socket.addClient(ws)
})

console.log(`сервер demo db-state: ws://127.0.0.1:${port}/db-state/ws`)
console.log("пользователи: admin/admin, manager/manager")
