import { DB_STATE_MESSAGES } from "@db-state/core"

export function createSocketHub(adapter, onMessage, options = {}) {
  const clients = new Set()
  const rawHandlers = new Set()
  const closeHandlers = new Set()

  // hello is the one message every client gets before authentication, so it
  // carries the server-provided identity (`serverInfo` config: build, branch,
  // commit). A login screen can show which server it is talking to without
  // an extra endpoint or a protocol round-trip.
  const hello = options.server
    ? { type: DB_STATE_MESSAGES.hello, server: options.server }
    : { type: DB_STATE_MESSAGES.hello }

  return {
    addClient(client, meta = {}) {
      Object.assign(client, meta)
      clients.add(client)
      // ws передаёт вторым аргументом признак бинарного фрейма — он решает,
      // команда это или кусок файла (см. handleMessage).
      client.on?.("message", (message, isBinary) => this.handleMessage(client, message, isBinary))
      client.on?.("close", () => this.handleClose(client))
      client.send?.(JSON.stringify(hello))
      return () => clients.delete(client)
    },

    async broadcast(message, options = {}) {
      adapter?.broadcast?.(message, options)

      const targets = [...clients]
      const delay = options.rate > 0 ? Math.ceil(1000 / options.rate) : 0

      for (let i = 0; i < targets.length; i += 1) {
        if (options.signal?.cancelled) return
        const client = targets[i]
        if (options.excludeSessionId && client.sessionId === options.excludeSessionId) continue
        client.send?.(JSON.stringify(message))
        if (delay > 0 && i < targets.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    },

    onConnection(handler) {
      this._onConnection = handler
    },

    handleConnection(client, meta = {}) {
      Object.assign(client, meta)
      clients.add(client)
      client.on?.("message", (message, isBinary) => this.handleMessage(client, message, isBinary))
      client.on?.("close", () => this.handleClose(client))
      this._onConnection?.(client, meta)
      return () => clients.delete(client)
    },

    // Бинарный фрейм — всегда сырые данные (кусок файла), даже если его байты
    // случайно читаются как JSON: иначе .json-файл или текст «12345» ушли бы
    // командой, и загрузка зависла бы. Признак даёт ws; без него (свой
    // адаптер, тест) командой считается только JSON-объект — число или
    // строка командой не бывают.
    async handleMessage(client, raw, isBinary) {
      const message = isBinary === true ? undefined : parseMessage(raw)
      if (message) {
        await onMessage?.(client, message)
        return
      }

      for (const handler of rawHandlers) {
        await handler(client, raw)
      }
    },

    async handleClose(client) {
      clients.delete(client)
      for (const handler of closeHandlers) {
        await handler(client)
      }
    },

    onRawMessage(handler) {
      rawHandlers.add(handler)
      return () => rawHandlers.delete(handler)
    },

    onClientClose(handler) {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },

    sendToUser(userId, type, payload) {
      const message = JSON.stringify({ type, payload })
      for (const client of clients) {
        if (client.userId === userId) client.send?.(message)
      }
    }
  }
}

// Команда протокола — всегда JSON-объект с type. Число, строка или массив
// командой не бывают: такие данные уходят обработчикам сырых сообщений.
function parseMessage(raw) {
  try {
    const value = JSON.parse(String(raw))
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}
