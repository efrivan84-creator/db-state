export function createHandlers(api) {
  return {
    add: async (req) => api.add({ ...(await readBody(req)), req }),
    count: async (req) => api.count({ ...(await readBody(req)), req }),
    getIds: async (req) => api.getIds({ ...(await readBody(req)), req }),
    getUnique: async (req) => api.getUnique({ ...(await readBody(req)), req }),
    load: async (req) => api.load({ ...(await readBody(req)), req }),
    remove: async (req) => api.remove({ ...(await readBody(req)), req }),
    sync: async (req) => api.sync({ ...(await readBody(req)), req }),
    update: async (req) => api.update({ ...(await readBody(req)), req })
  }
}

export async function handleRpc(router, client, message) {
  try {
    if (!client.user) throw new Error("Unauthorized")

    const handler = router[message.method]
    if (!handler) throw new Error(`Unknown db-state RPC method: ${message.method}`)

    const result = await handler({
      body: message.payload,
      client,
      userId: client.userId,
      sessionId: client.sessionId
    })

    client.send?.(JSON.stringify({
      type: "dbstate:rpc_result",
      id: message.id,
      result
    }))
  } catch (error) {
    client.send?.(JSON.stringify({
      type: "dbstate:rpc_error",
      id: message.id,
      error: error.message
    }))
  }
}

async function readBody(req) {
  if (!req) return {}
  if (req.body) return req.body
  if (typeof req.json === "function") return req.json()
  return {}
}
