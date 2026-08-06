import { WebSocketServer } from "ws"

import { createDbStateServer } from "@db-state/server-mongo"
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
    { _id: "admin", name: "Admin", access: { order: { read: {}, write: {} } } },
    {
      _id: "manager",
      name: "Manager",
      // Те же строки, но не все поля: margin менеджеру не виден и не правится.
      access: {
        order: {
          read: {},
          read_fields: ["status", "total", "comment"],
          write: {},
          write_fields: ["status", "comment"]
        }
      }
    }
  ],
  order: [
    {
      _id: "o1",
      status: "open",
      total: 1200,
      comment: "Visible note",
      margin: 340
    },
    {
      _id: "o2",
      status: "archived",
      total: 500,
      comment: "Closed last year",
      margin: 90
    }
  ]
})

const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  // Права целиком в access групп (см. seed _group): admin видит всё,
  // manager — те же строки без поля margin.
  //
  // Хуки — для того, что фильтром не выразить. Каждый объявляется один раз
  // на весь сервер, таблица разбирается внутри по ctx.table.
  hooks: {
    beforeRead: (ctx) => {
      if (ctx.table !== "order") return

      // Ограничиваем размер выборки для всех, включая админа.
      if (ctx.method === "getIds") ctx.limit = Math.min(ctx.limit || 50, 50)

      // Динамическое сужение полей: ctx.fields уходит в projection запроса.
      // Сузить можно, расширить сверх read_fields группы — нет.
      if (ctx.method === "load" && !ctx.user.groups.includes("admin")) {
        ctx.fields = ["status", "total", "comment"]
      }

      // Ничего не вернули → дальше решает access группы.
    },

    beforeWrite: (ctx) => {
      if (ctx.table !== "order") return

      // Архивные заказы не правит никто, даже админ.
      if (ctx.old?.status === "archived") {
        return { allowed: false, reason: "Архивный заказ изменять нельзя" }
      }

      // Нормализуем статус до записи.
      if (ctx.method === "update" && typeof ctx.set.status === "string") {
        ctx.set.status = ctx.set.status.toLowerCase()
      }
    },

    afterWrite: (ctx) => {
      // Точка для аудита: запись уже в базе и в журнале, запретить нельзя.
      console.log(`[audit] ${ctx.actorId} ${ctx.method} ${ctx.table}/${ctx.id}`)
    },

    errorWrite: (ctx) => {
      console.warn(`[denied] ${ctx.method} ${ctx.table}: ${ctx.error.message}`)
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

console.log(`db-state demo server: ws://127.0.0.1:${port}/db-state/ws`)
console.log("users: admin/admin, manager/manager")
