import { WebSocketServer } from "ws"
import { fileURLToPath } from "node:url"

import { createFileModule } from "@db-state/server-files"
import { createDbStateServer } from "@db-state/server-mongo"
import { createDemoMongo } from "./mongo.js"

const port = Number(process.env.DB_STATE_DEMO2_PORT ?? 8788)
const uploadRoot = process.env.DB_STATE_DEMO2_UPLOADS ?? fileURLToPath(new URL("../uploads", import.meta.url))

const { client, db: mongo } = await createDemoMongo()
const files = createFileModule({
  storage: uploadRoot,
  maxSize: 10 * 1024 * 1024,
  chunkSize: 256 * 1024,
  defaultPolicy: { mode: "registered" }
})

const dbState = createDbStateServer({
  mongo,
  tables: ["order", "log"],
  files,
  password: {
    hash: async (password) => `demo:${password}`,
    verify: async (password, passwordHash) => passwordHash === `demo:${password}`
  }
})

const wss = new WebSocketServer({ port, path: "/db-state/ws" })
wss.on("connection", (ws) => dbState.socket.addClient(ws))

console.log(`db-state demo2 admin server: ws://127.0.0.1:${port}/db-state/ws`)
console.log(`mongo database: ${mongo.databaseName}`)
console.log(`file storage: ${uploadRoot}`)
console.log("users: admin/admin, manager/manager, viewer/viewer")

process.on("SIGINT", close)
process.on("SIGTERM", close)

async function close() {
  await client.close()
  process.exit(0)
}
