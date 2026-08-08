import type { BaseDoc, Change, Filter, ListQuery, UpdatePatch } from "@db-state/core"
import type { AccessUser } from "./access"
import type { AuthRateLimitContext, AuthWarning, PasswordHasher } from "./auth"
import type { RpcHandler } from "./rpc"
import type { SocketHub } from "./socket"

export type { AccessContext, AccessDecision, AccessFilter, AccessTableEntry, AccessUser, UserAccess } from "./access"
export { accessAllows, matchesAccessFilter } from "./access"
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
  findOne(filter?: Record<string, unknown>, options?: { projection?: Record<string, 0 | 1> }): Promise<T | null>
  find(filter?: Record<string, unknown>, options?: { projection?: Record<string, 0 | 1> }): MongoCursorLike<T>
  countDocuments?(filter?: Record<string, unknown>): Promise<number>
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

  /** Tables exposed through CRUD/RPC. Service tables must be listed explicitly when you want to expose them. */
  tables: ReadonlyArray<string>

  /**
   * Directory holding the application's hooks as files:
   * `<dir>/beforeRead.js` applies to every table, `<dir>/order/beforeRead.js`
   * only to `order`. Each file default-exports the hook function; the shared
   * file runs before the table one, and the first explicit decision wins.
   *
   * The directory must exist and be readable. Its listing is read once on the
   * first hook use, then each known file is re-checked at most every
   * `reloadCheckMs`: editing a file applies within that window; adding or
   * removing one needs a restart. If a loaded file becomes unavailable, its
   * last good handler stays active until restart. Table directories may use
   * service names such as `_user`. Hooks run on every operation, so probing
   * the filesystem per request would cost more than it saves.
   *
   * Hooks of mounted modules are a separate layer and always run first — they
   * belong to the module, not to this configuration.
   */
  hooksDir?: string | URL

  /**
   * Directory with file-based RPC methods: "zad.get-num" maps to
   * `<dir>/zad/get-num.js`, whose default export is the handler. Files are
   * imported lazily on first call and re-checked at most every
   * `reloadCheckMs`. Every file method receives `db` (this server's Mongo)
   * and `api` (the db-state server) by default.
   */
  methodsDir?: string | URL

  /**
   * How often a hook or method file may be re-checked against its mtime, ms.
   * Default `60000`; `0` checks on every call, which suits development.
   */
  reloadCheckMs?: number

  /**
   * Extra properties spread into every file-based method request on top of
   * the defaults ({ db, api }); same-named keys override the defaults.
   */
  methodsContext?: Record<string, unknown>

  /** Optional extension modules mounted on the same db-state server/socket. */
  files?: DbStateServerModule | ReadonlyArray<DbStateServerModule>

  /** Password hashing primitive. Default: PBKDF2-SHA256. */
  password?: PasswordHasher

  /** Auth-hash generator. Default: 32 random bytes hex. */
  createAuthHash?: () => string

  /** Log-id generator. Default: `crypto.randomUUID` or timestamp+random fallback. */
  createLogId?: () => string

  /**
   * Sequential integer `_id` for new documents instead of a uuid.
   * `true` enables it for every table, an array limits it to the listed ones.
   * Numbers come from the counter collection via an atomic `$inc`.
   * An `_id` sent by the client is still used as-is. Default: `false`.
   */
  numericIds?: boolean | ReadonlyArray<string>

  /** Name of the counter collection used by `numericIds`. Default `"_counter"`. */
  counterCollection?: string

  /** Returns the user attached to an incoming RPC. Default: reads `req.client.user`. */
  getUser?: GetUserFn

  /** Name of the log collection. Default `"log"`. */
  logCollection?: string

  /** Prefix for service collections (`"cfg"` -> `cfg_user`, `cfg_group`, `cfg_log`). */
  servicePrefix?: string

  /** Alias for `servicePrefix`. */
  prefix?: string

  /** Name of the users table. Default `"_user"`. */
  userTable?: string

  /** Name of the groups table. Default `"_group"`. */
  groupTable?: string

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
  /**
   * Field whitelist for this request. `beforeRead` may set it to narrow the
   * returned fields; it can only narrow the group's `read_fields`.
   * An empty list keeps only `_id`.
   */
  fields?: string[]
  from?: string
  to?: string
  sessionId?: string
  actorId?: string
  now?: string
  rows?: T[]
  change?: Change<T>
  result?: unknown
  error?: Error
}

/**
 * What a hook may return:
 * - `false` / `{ allowed: false, reason }` — deny; the chain stops and the
 *   reason (when given) is sent to the client instead of the generic message;
 * - `true` / `{ allowed: true }` — allow; the user's group access is skipped;
 * - `undefined` / `null` — no decision; the user's group access decides.
 *
 * Mutations of `ctx` apply regardless of the returned value, so a hook can
 * rewrite the query and still leave the decision to the group access.
 *
 * `afterWrite` runs after the document, the change log and the broadcast are
 * already committed, so denying from it has no effect.
 */
export type ServerHookDecision =
  | boolean
  | { allowed: boolean; reason?: string }
  | void
  | null
  | undefined

export type ServerHook<T extends BaseDoc = BaseDoc> =
  (ctx: ServerHookContext<T>) => ServerHookDecision | Promise<ServerHookDecision>

/**
 * Hooks are declared once per name for the whole server; branch on `ctx.table`
 * inside the hook when a rule applies to one table only.
 */
export interface ServerHooks<T extends BaseDoc = BaseDoc> {
  beforeRead?: ServerHook<T>
  afterRead?: ServerHook<T>
  errorRead?: ServerHook<T>
  beforeWrite?: ServerHook<T>
  afterWrite?: ServerHook<T>
  errorWrite?: ServerHook<T>
}

export interface DbStateServerModule {
  table?: string
  tables?: ReadonlyArray<string>
  /**
   * Module hooks run before the application's file hooks of the same name; the
   * first explicit decision stops the chain. This is how a module protects its
   * own table — it is part of the module, not of the app configuration, so it
   * does not move into `hooksDir`.
   */
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
  withServicePrefix?(prefix?: string | null): DbStateServerModule
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
  /** More 12-hour windows are waiting; the client should call `sync` again immediately. */
  hasMore?: true
  /** The cursor is over 20 days old; discard local data and reload current state. */
  reset?: true
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

  /** Returns the next <=12-hour log window, or a reset marker when `from` is over 20 days old. */
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
