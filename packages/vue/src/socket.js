import { DB_STATE_MESSAGES, isDbStateEvent } from "@db-state/core"

export function createSocketFacade(options) {
  const listeners = new Map()
  const pending = new Map()
  const openWaiters = new Set()
  let ws

  return {
    get raw() {
      return ws
    },

    connect() {
      if (!options.wsUrl || typeof WebSocket === "undefined") return
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

      ws = new WebSocket(options.wsUrl)

      ws.addEventListener("open", () => {
        for (const resolve of openWaiters) resolve()
        openWaiters.clear()
        emit(listeners, DB_STATE_MESSAGES.socketOpen, { type: DB_STATE_MESSAGES.socketOpen })
      })

      ws.addEventListener("message", (event) => {
        const message = safeJson(event.data)
        if (!message) return
        if (message.type === DB_STATE_MESSAGES.rpcResult || message.type === DB_STATE_MESSAGES.rpcError) {
          settleRpc(pending, message)
          return
        }
        emit(listeners, message.type, message)
      })

      ws.addEventListener("close", () => {
        emit(listeners, DB_STATE_MESSAGES.socketClose, { type: DB_STATE_MESSAGES.socketClose })
        setTimeout(() => this.connect(), options.reconnectDelay)
      })
    },

    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(handler)
      return () => listeners.get(type)?.delete(handler)
    },

    send(type, payload) {
      if (isDbStateEvent(type)) throw new Error("dbstate:* events are reserved")
      ws?.send(JSON.stringify({ type, payload }))
    },

    async rpc(method, payload) {
      if (!ws) this.connect()
      await waitForOpen(() => ws, openWaiters, options.rpcTimeout)

      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`db-state RPC timeout: ${method}`))
        }, options.rpcTimeout)

        pending.set(id, { resolve, reject, timer })
        ws.send(JSON.stringify({ type: DB_STATE_MESSAGES.rpc, id, method, payload }))
      })
    },

    async system(type, payload = {}) {
      if (!ws) this.connect()
      await waitForOpen(() => ws, openWaiters, options.rpcTimeout)

      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`
      return new Promise((resolve, reject) => {
        const okType = `${type}_result`
        const errType = `${type}_error`
        const offOk = this.on(okType, (message) => {
          if (message.id !== id) return
          cleanup()
          resolve(message)
        })
        const offErr = this.on(errType, (message) => {
          if (message.id !== id) return
          cleanup()
          reject(new Error(message.error || `${type} failed`))
        })
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`db-state system timeout: ${type}`))
        }, options.rpcTimeout)
        const cleanup = () => {
          clearTimeout(timer)
          offOk()
          offErr()
        }

        ws.send(JSON.stringify({ type, id, ...payload }))
      })
    }
  }
}

function settleRpc(pending, message) {
  const item = pending.get(message.id)
  if (!item) return

  clearTimeout(item.timer)
  pending.delete(message.id)

  if (message.type === DB_STATE_MESSAGES.rpcError) {
    item.reject(new Error(message.error || "db-state RPC error"))
  } else {
    item.resolve(message.result)
  }
}

function waitForOpen(getWs, waiters, timeout) {
  const ws = getWs()
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      waiters.delete(done)
      reject(new Error("db-state WebSocket is not open"))
    }, timeout)

    waiters.add(done)
  })
}

function safeJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function emit(listeners, type, payload) {
  for (const handler of listeners.get(type) ?? []) {
    handler(payload)
  }
}
