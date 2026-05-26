import type { BaseDoc, Change, Filter, ListQuery, UpdatePatch } from "@db-state/core"
import type { AccessConfig, AccessUser } from "./access"
import type { AuthRateLimitContext, AuthWarning, PasswordHasher } from "./auth"
import type { SocketHub } from "./socket"

export type { AccessConfig, AccessContext, AccessDecision, AccessRule, AccessUser, ServerPermissionRule, PermissionPart } from "./access"
export type { PasswordHasher, AuthHandlers, LoginMessage, AuthMessage, LogoutMessage, AuthRateLimitContext, AuthWarning } from "./auth"
export type { BroadcastOptions, ClientMeta, DetachClient, SocketAdapter, SocketClient, SocketHub } from "./socket"
export type { RpcHandler, RpcMeta, RpcRequest, RpcRouter } from "./rpc"
export type { BaseDoc, Change, ChangeAction, Filter, ListQuery, SortSpec, UpdatePatch } from "@db-state/core"

// ---------------------------------------------------------------------------
// Mongo abstraction (duck-typed to avoid a hard dependency on the driver)
// ---------------------------------------------------------------------------

/** Minimum subset of a Mongo cursor used by the library. */
export interface MongoCursorLike<T = unknown> {
  sort(spec: Record<string, 1 | -1>): MongoCursorLike<T>
  skip(count: number): MongoCursorLike<T>
  limit(count: number): MongoCursorLike<T>
  toArray(): Promise<T[]>
}

/** Minimum subset of a Mongo collection used by the library. */
export interface MongoCollectionLike<T = unknown> {
  findOne(filter?: Record<string, unknown>): Promise<T | null>
  find(filter?: Record<string, unknown>): MongoCursorLike<T>
  insertOne(doc: T): Promise<{ insertedId: unknown }>
  insertMany?(docs: T[]): Promise<{ insertedCount: number }>
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean }
  ): Promise<{ acknowledged: boolean }>
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>
}

/** Minimum subset of a Mongo database used by the library. */
export interface MongoDatabaseLike {
  collection<T = unknown>(name: string): MongoCollectionLike<T>
  databaseName?: string
}

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

/** Resolver responsible for turning an RPC request into an authenticated user. */
export type GetUserFn = (ctx: {
  req?: { client?: { user?: AccessUser; userId?: string; groups?: string[] } } | null
  client?: { user?: AccessUser; userId?: string; groups?: string[] } | null
}) => Promise<AccessUser | undefined> | AccessUser | undefined

/** Options accepted by {@link createDbStateServer}. */
export interface DbStateServerConfig {
  /** Mongo database the server reads and writes through. */
  mongo: MongoDatabaseLike

  /** Application tables. Service tables are added automatically. */
  tables: ReadonlyArray<string>

  /** Optional code-level access rules; checked before `_permission` rows. */
  access?: AccessConfig

  /** Optional lifecycle hooks around server reads and writes. */
  hooks?: ServerHooks

  /** Optional extension modules mounted on the same db-state server/socket. */
  files?: DbStateServerModule | ReadonlyArray<DbStateServerModule>

  /** Password hashing primitive. Default: PBKDF2-SHA256. */
  password?: PasswordHasher

  /** Auth-hash generator. Default: 32 random bytes hex. */
  createAuthHash?: () => string

  /** Log-id generator. Default: `crypto.randomUUID` or timestamp+random fallback. */
  createLogId?: () => string

  /** Returns the user attached to an incoming RPC. Default: reads `req.client.user`. */
  getUser?: GetUserFn

  /** Name of the log collection. Default `"log"`. */
  logCollection?: string

  /** Name of the permissions table. Default `"_permission"`. */
  permissionTable?: string

  /** Name of the users table. Default `"_user"`. */
  userTable?: string

  /** Actor id used for server/internal writes when no authenticated user id exists. Default `"system"`. */
  systemUserId?: string

  /** User fields accepted by `dbstate:login`. Default `["login"]`. */
  authLoginFields?: ReadonlyArray<string>

  /** Normalizes the submitted login value before matching a configured auth field. Default: `String(value).trim()`. */
  normalizeAuthLogin?: (value: unknown, field: string) => string

  /** Optional login/hash-auth rate-limit hook. Return `false` to reject with `Too many attempts`. */
  authRateLimit?: (ctx: AuthRateLimitContext) => Promise<boolean | void> | boolean | void

  /** Optional security warning hook, e.g. for ambiguous login identifiers. */
  onAuthWarning?: (warning: AuthWarning) => void

  /** Returns the current ISO timestamp. Default: `new Date().toISOString()`. */
  now?: () => string

  /** Maximum number of changes returned by a single `sync`. Default `1000`. */
  syncLimit?: number

  /** Optional out-of-process broadcast adapter (e.g. Redis pubsub). */
  socket?: import("./socket").SocketAdapter

  /** Debounce delay before waking clients after writes, ms. Default `3000`. */
  changesBroadcastDelay?: number

  /** Maximum clients to wake per second during a changes broadcast wave. Default `100`. */
  changesBroadcastRate?: number
}

export interface ServerHookContext<T extends BaseDoc = BaseDoc> {
  req?: unknown
  user?: AccessUser
  table?: string
  method: "load" | "getIds" | "getUnique" | "count" | "sync" | "add" | "update" | "remove"
  id?: string
  action?: Change<T>["action"]
  obj?: T
  old?: T
  set?: Partial<T> & Record<string, unknown>
  unset?: string[]
  clientObj?: Partial<T>
  clientSet?: Partial<T> & Record<string, unknown>
  clientUnset?: string[]
  filter?: Filter<T>
  sort?: Record<string, 1 | -1>
  skip?: number
  limit?: number
  field?: string
  from?: string
  to?: string
  sessionId?: string
  now?: string
  rows?: T[]
  change?: Change<T>
  result?: unknown
  error?: Error
}

export type ServerHook<T extends BaseDoc = BaseDoc> =
  (ctx: ServerHookContext<T>) => void | Promise<void>

export interface ServerHookSet<T extends BaseDoc = BaseDoc> {
  beforeRead?: ServerHook<T>
  afterRead?: ServerHook<T>
  errorRead?: ServerHook<T>
  beforeWrite?: ServerHook<T>
  afterWrite?: ServerHook<T>
  errorWrite?: ServerHook<T>
}

export type ServerHooks =
  ServerHookSet & Record<string, ServerHookSet | ServerHook | undefined>

export interface DbStateServerModule {
  table?: string
  tables?: ReadonlyArray<string>
  access?: AccessConfig
  hooks?: ServerHooks
  bind?(context: {
    api: DbStateServer
    config: unknown
    mongo: MongoDatabaseLike
    socket: SocketHub
  }): void
  handleMessage?(
    client: unknown,
    message: { type?: string; [key: string]: unknown }
  ): Promise<boolean> | boolean
  handleRawMessage?(client: unknown, raw: unknown): Promise<void> | void
  handleClose?(client: unknown): Promise<void> | void
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** Request signature for the public CRUD methods. */
export interface RequestContext {
  req?: unknown
  sessionId?: string
}

export interface UpdateRequest<T extends BaseDoc = BaseDoc> extends RequestContext, UpdatePatch<T> {
  table: string
  id: string
}

export interface AddRequest<T extends BaseDoc = BaseDoc> extends RequestContext {
  table: string
  obj: Partial<T> & { _id?: string; id?: string }
}

export interface RemoveRequest extends RequestContext {
  table: string
  id: string
}

export interface LoadRequest extends RequestContext {
  table: string
  id: string
}

export interface ListRequest<T extends BaseDoc = BaseDoc> extends RequestContext, ListQuery<T> {
  table: string
}

export interface UniqueRequest<T extends BaseDoc = BaseDoc> extends RequestContext {
  table: string
  field: string
  filter?: Filter<T>
}

export interface CountRequest<T extends BaseDoc = BaseDoc> extends RequestContext {
  table: string
  filter?: Filter<T>
}

export interface SyncRequest extends RequestContext {
  from: string
  limit?: number
}

export interface MutationResult<T extends BaseDoc = BaseDoc> {
  ok: true
  id?: string
  change: Change<T>
}

export interface SyncResult {
  /** ISO timestamp the client should write back as the new `time1`. */
  to: string
  /** Permission-filtered list of changes the caller may see. */
  changes: Change[]
}

/** Object returned by {@link createDbStateServer}. */
export interface DbStateServer {
  socket: SocketHub

  /** Inserts a new document, appends to the log, and broadcasts the change. */
  add<T extends BaseDoc>(input: AddRequest<T>): Promise<MutationResult<T>>

  /** Counts documents matching the filter, after permission filtering. */
  count<T extends BaseDoc>(input: CountRequest<T>): Promise<number>

  /** Returns ids of documents matching the filter, after permission filtering. */
  getIds<T extends BaseDoc>(input: ListRequest<T>): Promise<string[]>

  /** Returns distinct values for a field across matching documents. */
  getUnique<T extends BaseDoc, V = unknown>(input: UniqueRequest<T>): Promise<V[]>

  /** Loads a single document by id, projected to readable fields. */
  load<T extends BaseDoc>(input: LoadRequest): Promise<T | null>

  /** Deletes a document, appends to the log, and broadcasts the change. */
  remove<T extends BaseDoc>(input: RemoveRequest): Promise<MutationResult<T>>

  /** Returns log entries after `from` filtered by the caller's read access. */
  sync(input: SyncRequest): Promise<SyncResult>

  /**
   * Updates a document, appends to the log, and broadcasts the change.
   * Throws when the caller is not allowed to touch any of the field paths.
   */
  update<T extends BaseDoc>(input: UpdateRequest<T>): Promise<MutationResult<T>>
}

/**
 * Creates a db-state server bound to a Mongo database.
 *
 * @example
 * import { createDbStateServer } from "@db-state/server-mongo"
 *
 * const dbState = createDbStateServer({
 *   mongo,
 *   tables: ["order", "product"]
 * })
 *
 * // Attach a ws client (e.g. from the `ws` library):
 * wss.on("connection", (ws) => dbState.socket.addClient(ws))
 */
export function createDbStateServer(config: DbStateServerConfig): DbStateServer
