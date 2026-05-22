/** Generic message envelope sent or received over the WebSocket. */
export interface SocketMessage {
  type: string
  [key: string]: unknown
}

/** Handler signature for messages dispatched by {@link DbStateSocketFacade.on}. */
export type SocketMessageHandler = (message: SocketMessage) => void

/** Disposer returned by {@link DbStateSocketFacade.on}; unregisters the handler. */
export type SocketUnsubscribe = () => void

/**
 * Public WebSocket facade exposed at `state.socket`. Hides reconnection,
 * RPC correlation and event multiplexing.
 *
 * Custom event names (anything not starting with `dbstate:`) may be used
 * via `send`/`on` to share the same socket between the library and the app.
 */
export interface DbStateSocketFacade {
  /** Live native `WebSocket` instance, or `undefined` before first connect. */
  readonly raw: WebSocket | undefined

  /** Opens the WebSocket if not already opening/open. Auto-reconnects on close. */
  connect(): void

  /**
   * Subscribes to a typed message. Returns a disposer.
   * The `dbstate:*` namespace is reserved by the library, but consumers may
   * subscribe to those events for observability.
   */
  on(type: string, handler: SocketMessageHandler): SocketUnsubscribe

  /**
   * Sends a custom event over the same socket. Throws if `type` is in the
   * reserved `dbstate:*` namespace.
   */
  send(type: string, payload?: unknown): void

  /** Issues a library RPC call and resolves with `result` from the server. */
  rpc<T = unknown>(method: string, payload?: unknown): Promise<T>

  /**
   * Performs a library "system" round-trip — used internally by `login`,
   * `auth`, `logout`. Replies arrive as `${type}_result` / `${type}_error`.
   */
  system<T = unknown>(type: string, payload?: Record<string, unknown>): Promise<T>
}

export function createSocketFacade(options: {
  wsUrl?: string
  reconnectDelay?: number
  rpcTimeout?: number
  onError?: (error: Error) => void
}): DbStateSocketFacade
