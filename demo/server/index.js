import { WebSocketServer } from "ws"

import { createDbStateServer } from "../../packages/server-mongo/src/index.js"
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
    { _id: "admin", name: "Admin" },
    { _id: "manager", name: "Manager" }
  ],
  _permission: [
    {
      _id: "perm_order_admin",
      table: "order",
      priority: 10,
      read: { groups: ["admin"] },
      write: { groups: ["admin"] }
    },
    {
      _id: "perm_order_manager",
      table: "order",
      priority: 1,
      read: { groups: ["manager"], fields: ["_id", "status", "total", "comment"] },
      write: { groups: ["manager"], fields: ["status", "comment"] }
    }
  ],
  order: [
    {
      _id: "o1",
      status: "open",
      total: 1200,
      comment: "Visible note",
      margin: 340
    }
  ]
})

const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
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
