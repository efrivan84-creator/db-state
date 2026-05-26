import { DB_STATE_MESSAGES } from "@db-state/core"

export function createHandlers(api) {
  return {
    add: async (req) => withMeta(req, await api.add({ ...(await readBody(req)), req })),
    count: async (req) => withMeta(req, await api.count({ ...(await readBody(req)), req })),
    getIds: async (req) => withMeta(req, await api.getIds({ ...(await readBody(req)), req })),
    getUnique: async (req) => withMeta(req, await api.getUnique({ ...(await readBody(req)), req })),
    load: async (req) => withMeta(req, await api.load({ ...(await readBody(req)), req })),
    remove: async (req) => withMeta(req, await api.remove({ ...(await readBody(req)), req })),
    sync: async (req) => withMeta(req, await api.sync({ ...(await readBody(req)), req })),
    update: async (req) => withMeta(req, await api.update({ ...(await readBody(req)), req }))
  }
}

export async function handleRpc(router, client, message) {
  try {
    if (!client.user) throw new Error("Unauthorized")

    const handler = router[message.method]
    if (!handler) throw new Error(`Unknown db-state RPC method: ${message.method}`)

    const response = unwrapRpcResponse(await handler({
      body: message.payload,
      client,
      userId: client.userId,
      sessionId: client.sessionId
    }))

    const out = {
      type: DB_STATE_MESSAGES.rpcResult,
      id: message.id,
      result: response.result
    }
    if (response.meta) out.meta = response.meta
    client.send?.(JSON.stringify(out))
  } catch (error) {
    client.send?.(JSON.stringify({
      type: DB_STATE_MESSAGES.rpcError,
      id: message.id,
      error: error.message
    }))
  }
}

function withMeta(req, result) {
  if (!req?.dbStateMeta || Object.keys(req.dbStateMeta).length === 0) return result
  return { __dbStateRpcResponse: true, result, meta: req.dbStateMeta }
}

function unwrapRpcResponse(value) {
  if (value?.__dbStateRpcResponse) return { result: value.result, meta: value.meta }
  return { result: value }
}

async function readBody(req) {
  if (!req) return {}
  if (req.body) return req.body
  if (typeof req.json === "function") return req.json()
  return {}
}
