import { WebSocketServer } from "ws"

import { createDbStateServer } from "../../packages/server-mongo/src/index.js"
import { createDemoMongo } from "./mongo.js"

const port = Number(process.env.DB_STATE_DEMO2_PORT ?? 8788)

const { client, db: mongo } = await createDemoMongo()

const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  password: {
    hash: async (password) => `demo:${password}`,
    verify: async (password, passwordHash) => passwordHash === `demo:${password}`
  }
})

const wss = new WebSocketServer({ port, path: "/db-state/ws" })
wss.on("connection", (ws) => dbState.socket.addClient(ws))

console.log(`db-state demo2 admin server: ws://127.0.0.1:${port}/db-state/ws`)
console.log(`mongo database: ${mongo.databaseName}`)
console.log("users: admin/admin, manager/manager, viewer/viewer")

process.on("SIGINT", close)
process.on("SIGTERM", close)

async function close() {
  await client.close()
  process.exit(0)
}
