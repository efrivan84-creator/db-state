import type { AccessObject, BaseDoc, Change, ServiceGroup, ServiceUser } from "@db-state/core"
import type { DbStateCache } from "./cache.js"
import type { LoadingKeyRef } from "./keys.js"
import type { DbStateSocketFacade } from "./socket.js"
import type { StorageLike } from "./storage.js"
import type { ChangeUnsubscribe, TableApi } from "./table.js"

export type { DbStateCache } from "./cache.js"
export type { LoadingKeyRef } from "./keys.js"
export type { DbStateSocketFacade, SocketMessage, SocketMessageHandler, SocketUnsubscribe } from "./socket.js"
export type { StorageLike } from "./storage.js"
export type {
  Filter,
  ListQuery,
  MutationResult,
  PageKey,
  ReactiveDoc,
  SortSpec,
  TableApi,
  ChangeUnsubscribe,
  TableAddHandler,
  TableChangeHandler,
  TableDeleteHandler,
  TableEditHandler,
  UpdateArgs
} from "./table.js"
export type {
  BaseDoc,
  Change,
  ChangeAction,
  ServiceGroup,
  ServiceUser
} from "@db-state/core"

export { createIndexedDbCache, createMemoryCache, createStorageCache } from "./cache.js"

// ---------------------------------------------------------------------------
// Schema generic
// ---------------------------------------------------------------------------

/**
 * Shape of the schema generic accepted by {@link createDbState}.
 *
 * Map your table names to document types. Service tables (`_user`,
 * `_group`) are inferred automatically with reasonable
 * defaults but can be overridden by including them here explicitly.
 *
 * @example
 * type Schema = {
 *   order: { _id: string; status: "open" | "closed"; total: number }
 *   product: { _id: string; sku: string; price: number }
 * }
 * const state = createDbState<Schema>(["order", "product"])
 */
export type DbStateSchema = Record<string, BaseDoc>

/** Service tables merged into every schema. */
export interface DefaultServiceTables {
  _user: ServiceUser
  _group: ServiceGroup
}

/** Combined map = user schema + service tables (user schema wins on overlap). */
export type SchemaWithServiceTables<TSchema extends DbStateSchema> =
  Omit<DefaultServiceTables, keyof TSchema> & TSchema

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Connection / authentication / sync status reported on `state.sync` and `state.auth`. */
export type SyncStatus = "idle" | "syncing" | "error"
export type AuthStatus = "anonymous" | "authorizing" | "authorized" | "restored"

/** Options accepted by {@link createDbState}. */
export interface DbStateOptions<TSchema extends DbStateSchema = DbStateSchema> {
  /** Tables exposed on the client. Service tables must be listed explicitly when needed. */
  tables: ReadonlyArray<keyof TSchema & string>

  /** WebSocket URL. Defaults to `${ws-mapped origin}/db-state/ws`. */
  wsUrl?: string

  /** Whether to open the WebSocket immediately. Default `true`. */
  autoConnect?: boolean

  /** Whether to attempt hash-based auth after reconnect/page refresh. Default `true`. */
  autoAuth?: boolean

  /** Custom record cache. Defaults to {@link createIndexedDbCache}. */
  cache?: DbStateCache

  /** Storage for `time1`. Default: `localStorage`. */
  metaStorage?: StorageLike
  /** Storage for `sessionId`. Default: `sessionStorage`. */
  sessionStorage?: StorageLike
  /** Storage for the saved sign-in. Default: `localStorage`. */
  authStorage?: StorageLike

  /** Custom key names for the storages above. */
  sessionKey?: string
  syncKey?: string

  /**
   * Key holding the saved sign-in as JSON `{ userId, hash }`.
   * Default `"db-state.auth"`. JSON keeps the type of `userId`, which a
   * plain string value would lose when `_id` is numeric.
   */
  authKey?: string

  /** Pre-seed the saved user id (overrides `authStorage`). */
  userId?: string | number

  /** Reconnect delay after socket close, ms. Default `1000`. */
  reconnectDelay?: number
  /** RPC timeout, ms. Default `15000`. */
  rpcTimeout?: number
  /** Background safety-sync interval, ms. Default `0` (disabled). */
  safetySyncInterval?: number
  /** Run `syncNow()` after successful hash auth/reconnect. `login()` does not sync. Default `true`. */
  syncOnAuth?: boolean
  /** Default wait timeout for `getAsync`, ms. Default `15000`. */
  waitTimeout?: number
  /** How long writes wait for restored auth before failing, ms. Default `3000`. */
  writeAuthTimeout?: number

  /** Debounce window before refreshing matching `countRef`s after a change. ms. Default `50`. */
  countRefreshDelay?: number
  /** Debounce window before refreshing matching `idsRef`s after a change. ms. Default `50`. */
  idsRefreshDelay?: number

  /** Logger hook for background errors (auto-auth, safety-sync). Default `console.error`. */
  onError?: (error: Error) => void
}

// ---------------------------------------------------------------------------
// Reactive store
// ---------------------------------------------------------------------------

export interface SyncState {
  connected: boolean
  sessionId: string
  status: SyncStatus
  /** ISO timestamp of the last successful sync (exclusive lower bound for next sync). */
  time1: string
}

export interface AuthState {
  /** Keeps the type the server sent: a number when `_id` is numeric. */
  userId: string | number | null
  hash: string | null
  /** Login of the signed-in user, from the server response. `null` when anonymous. */
  login: string | null
  /** Groups of the signed-in user. Empty when anonymous. */
  groups: string[]
  /** Merged access object of the user's groups. `null` when anonymous. */
  access: AccessObject | null
  status: AuthStatus
}

/** Result of `state.login` / `authByHash`. */
export interface AuthResult {
  ok: true
  userId: string | number
  login?: string
  hash: string
  groups: string[]
  access?: AccessObject
}

/** Per-table reactive accessors injected onto the store. */
export type TableAccessors<TSchema extends DbStateSchema> = {
  [K in keyof SchemaWithServiceTables<TSchema>]: TableApi<SchemaWithServiceTables<TSchema>[K]>
}

/** The reactive store returned by {@link createDbState}. */
export type DbState<TSchema extends DbStateSchema = DbStateSchema> =
  TableAccessors<TSchema> & {
    sync: SyncState
    auth: AuthState
    socket: DbStateSocketFacade

    /** Returns or creates a page-level reactive loading state. */
    getKeyRef(key: string): LoadingKeyRef

    /** Resets the page-level loading state to idle and `start: false`. */
    resetKey(key: string): void

    /** Registers a callback for every applied change from any table. */
    onChange(callback: (change: Change) => void): ChangeUnsubscribe

    /** Registers an extension table at runtime. Used by optional modules such as @db-state/vue-files. */
    registerTable<K extends string>(table: K): TableApi<BaseDoc>

    /** Catches up all pending 12-hour sync windows and handles server-requested cache resets. */
    syncNow(): Promise<void>

    /** Applies a single change locally (used internally by RPCs and sync). */
    applyChange(change: Change, options?: { refreshQueries?: boolean }): Promise<void>

    /**
     * Wipes the IndexedDB cache, the in-memory reactive tables, the
     * `time1` cursor and the session id. Auth is NOT cleared — call
     * {@link DbState.logout} for that.
     */
    clearLocalDB(): Promise<void>

    /** Authenticates by login/password. Saves `userId` + `hash` to `authStorage`. */
    login(login: string, password: string): Promise<AuthResult>

    /** Authenticates by previously stored `userId` + `hash`. Returns `true` on success. */
    authByHash(): Promise<boolean>

    /**
     * Performs the auto-auth flow on reconnect: hash-auth if credentials
     * are present, otherwise no-op. Idempotent — safe to call repeatedly.
     */
    autoAuth(): Promise<boolean>

    /** Tells the server to terminate the session and clears saved auth. Does NOT clear local data. */
    logout(): Promise<void>

    /** Resolves when auth becomes `authorized`; returns `false` only when `timeout` elapses. */
    waitForAuthorized(timeout?: number): Promise<boolean>
  }

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a reactive client store backed by a remote db-state server.
 *
 * @example
 * import { createDbState } from "@db-state/vue"
 *
 * type Schema = {
 *   order: { _id: string; status: string; total: number }
 * }
 * export const state = createDbState<Schema>({
 *   tables: ["order"],
 *   wsUrl: "wss://example.com/db-state/ws"
 * })
 */
export function createDbState<TSchema extends DbStateSchema = DbStateSchema>(
  options: DbStateOptions<TSchema>
): DbState<TSchema>

/** Shortcut — passing just the table list is equivalent to `{ tables }`. */
export function createDbState<TSchema extends DbStateSchema = DbStateSchema>(
  tables: ReadonlyArray<keyof TSchema & string>
): DbState<TSchema>
