import { DB_STATE_EVENTS } from "@db-state/core"

export function createSocketHub(adapter, onMessage) {
  const clients = new Set()

  return {
    addClient(client, meta = {}) {
      Object.assign(client, meta)
      clients.add(client)
      client.on?.("message", (message) => this.handleMessage(client, message))
      client.send?.(JSON.stringify({ type: DB_STATE_EVENTS.hello }))
      return () => clients.delete(client)
    },

    broadcast(message, options = {}) {
      adapter?.broadcast?.(message, options)

      for (const client of clients) {
        if (options.excludeSessionId && client.sessionId === options.excludeSessionId) continue
        client.send?.(JSON.stringify(message))
      }
    },

    onConnection(handler) {
      this._onConnection = handler
    },

    handleConnection(client, meta = {}) {
      Object.assign(client, meta)
      clients.add(client)
      client.on?.("message", (message) => this.handleMessage(client, message))
      this._onConnection?.(client, meta)
      return () => clients.delete(client)
    },

    async handleMessage(client, raw) {
      const message = parseMessage(raw)
      if (message) await onMessage?.(client, message)
    },

    sendToUser(userId, type, payload) {
      const message = JSON.stringify({ type, payload })
      for (const client of clients) {
        if (client.userId === userId) client.send?.(message)
      }
    }
  }
}

function parseMessage(raw) {
  try {
    return JSON.parse(String(raw))
  } catch {
    return undefined
  }
}
