import { MongoClient } from "mongodb"

const seed = {
  _user: [
    { _id: "u_admin", login: "admin", passwordHash: "demo:admin", groups: ["admin"], disabled: false },
    { _id: "u_manager", login: "manager", passwordHash: "demo:manager", groups: ["manager"], disabled: false },
    { _id: "u_viewer", login: "viewer", passwordHash: "demo:viewer", groups: ["viewer"], disabled: false }
  ],
  _group: [
    { _id: "admin", name: "Administrators" },
    { _id: "manager", name: "Order managers" },
    { _id: "viewer", name: "Read only" }
  ],
  _permission: [
    { _id: "perm_user_admin", table: "_user", priority: 100, read: { groups: ["admin"] }, write: { groups: ["admin"] } },
    { _id: "perm_group_admin", table: "_group", priority: 100, read: { groups: ["admin"] }, write: { groups: ["admin"] } },
    { _id: "perm_permission_admin", table: "_permission", priority: 100, read: { groups: ["admin"] }, write: { groups: ["admin"] } },
    { _id: "perm_order_admin", table: "order", priority: 100, read: { groups: ["admin"] }, write: { groups: ["admin"] } },
    {
      _id: "perm_order_manager",
      table: "order",
      priority: 20,
      read: { groups: ["manager"], fields: ["_id", "status", "total", "comment", "ownerId"] },
      write: { groups: ["manager"], fields: ["status", "comment"] }
    },
    {
      _id: "perm_order_viewer",
      table: "order",
      priority: 10,
      read: { groups: ["viewer"], fields: ["_id", "status", "total"] },
      write: { groups: ["viewer"], action: false }
    }
  ],
  order: [
    { _id: "o1", status: "open", total: 1200, margin: 340, comment: "First order", ownerId: "u_manager" },
    { _id: "o2", status: "packed", total: 840, margin: 190, comment: "Priority shipment", ownerId: "u_manager" },
    { _id: "o3", status: "closed", total: 2600, margin: 720, comment: "Paid", ownerId: "u_admin" }
  ]
}

export async function createDemoMongo() {
  const uri = mongoUri()
  const dbName = process.env.DB_STATE_MONGO_DB ?? "db_state_demo2"
  const client = new MongoClient(uri)

  await client.connect()

  const db = client.db(dbName)
  await seedDemo(db)

  return { client, db }
}

async function seedDemo(db) {
  for (const name of ["_user", "_group", "_permission", "order", "log"]) {
    await db.collection(name).deleteMany({})
  }

  for (const [name, rows] of Object.entries(seed)) {
    if (rows.length) await db.collection(name).insertMany(rows)
  }

  await db.collection("log").createIndex({ createdAt: 1, logId: 1 })
  await db.collection("_permission").createIndex({ table: 1, priority: -1 })
}

function mongoUri() {
  if (process.env.DB_STATE_MONGO_URI) return process.env.DB_STATE_MONGO_URI

  const user = process.env.DB_STATE_MONGO_USER
  const password = process.env.DB_STATE_MONGO_PASSWORD
  const host = process.env.DB_STATE_MONGO_HOST ?? "localhost:27017"

  if (user && password) {
    return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/?authSource=admin`
  }

  return `mongodb://${host}`
}
