/**
 * Minimal duck-typed client for socket-level operations. Any object that
 * provides `send` (and optionally `on` for an incoming-message hook)
 * works — `ws.WebSocket`, custom adapters, mock clients in tests.
 */
export interface SocketClient {
  send?(raw: string): void
  on?(event: "message", listener: (raw: unknown) => void): void
  userId?: string
  user?: { _id: string; login?: string; groups?: string[] }
  sessionId?: string
}

/** Adapter for fan-out broadcasts beyond the local process (Redis, Kafka, etc). */
export interface SocketAdapter {
  broadcast?(message: unknown, options?: BroadcastOptions): void
}

/** Options accepted by {@link SocketHub.broadcast}. */
export interface BroadcastOptions {
  /** Optional helper for app-level custom broadcasts. db-state change wake-ups do not use it. */
  excludeSessionId?: string
  /** Maximum clients to wake per second. `0`/undefined sends without throttling. */
  rate?: number
  /** Internal cancellation token used when a newer database change supersedes an active wave. */
  signal?: { cancelled?: boolean }
}

/** Connection metadata supplied when registering a client. */
export interface ClientMeta {
  user?: { _id: string; login?: string; groups?: string[] }
  userId?: string
  sessionId?: string
}

/** Disposer returned by {@link SocketHub.addClient}. */
export type DetachClient = () => void

/**
 * Server-side socket fan-out hub. Holds the active clients, parses incoming
 * messages and dispatches them into the provided RPC/auth handler.
 */
export interface SocketHub {
  /** Registers a connected client and starts forwarding its messages. */
  addClient(client: SocketClient, meta?: ClientMeta): DetachClient

  /** Sends a message to every connected client, optionally rate-limited. */
  broadcast(message: unknown, options?: BroadcastOptions): Promise<void>

  /** Registers a custom `onConnection` listener — for adapters that handle connect events manually. */
  onConnection(handler: (client: SocketClient, meta: ClientMeta) => void): void

  /** Used by adapters that route connection events themselves. */
  handleConnection(client: SocketClient, meta?: ClientMeta): DetachClient

  /** Parses a raw socket frame and dispatches into the message handler. */
  handleMessage(client: SocketClient, raw: unknown): Promise<void>

  /** Sends a single payload to every socket whose `userId` matches. */
  sendToUser(userId: string, type: string, payload?: unknown): void
}

export function createSocketHub(
  adapter: SocketAdapter | null | undefined,
  onMessage: (client: SocketClient, message: { type: string; [key: string]: unknown }) => Promise<void> | void
): SocketHub
