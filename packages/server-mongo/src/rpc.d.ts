import type { SocketClient } from "./socket"

/** Request envelope passed into every router handler. */
export interface RpcRequest<TBody = Record<string, unknown>> {
  body: TBody
  client: SocketClient
  userId?: string
  sessionId?: string
  /** Optional metadata appended to the `dbstate:rpc_result` envelope. */
  dbStateMeta?: RpcMeta
}

/** Optional metadata sent next to an RPC result without changing the result shape. */
export interface RpcMeta {
  /** True when rows/changes were hidden by read permissions. */
  accessFiltered?: boolean
  /** True when object fields/change fields were hidden by read field whitelists. */
  fieldsFiltered?: boolean
  /** Number of rows/changes hidden by read permissions in this response window. */
  denied?: number
  [key: string]: unknown
}

/** Handler signature: receives the request, returns the result that will be sent back. */
export type RpcHandler<TBody = Record<string, unknown>, TResult = unknown> =
  (req: RpcRequest<TBody>) => Promise<TResult>

/** Map of method name → handler used by {@link handleRpc}. */
export type RpcRouter = Record<string, RpcHandler>

/** Builds the default router from an `api` object exposing add/update/remove/etc. */
export function createHandlers(api: {
  add: RpcHandler
  count: RpcHandler
  getIds: RpcHandler
  getUnique: RpcHandler
  load: RpcHandler
  remove: RpcHandler
  sync: RpcHandler
  update: RpcHandler
}): RpcRouter

/**
 * Dispatches a `dbstate:rpc` message into the router, sending the result
 * back as `dbstate:rpc_result` or `dbstate:rpc_error`. Rejects unauthenticated
 * clients with `"Unauthorized"`.
 */
export function handleRpc(
  router: RpcRouter,
  client: SocketClient,
  message: { id: string; method: string; payload?: unknown }
): Promise<void>
