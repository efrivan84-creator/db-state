import type { BaseDoc, Change } from "@db-state/core"

/**
 * Document filter inside an access entry: dot-path -> expected value.
 * `{}` matches every document. Values support placeholders:
 * `"$adminid"` — the current user's id, `"$groupid"` — any of the user's groups.
 */
export type AccessFilter = Record<string, unknown>

/** Per-table access entry. After merge, filters may become any-of arrays. */
export interface AccessTableEntry {
  /** Row filter for reads: `{}` — all rows, a filter — only matching rows. */
  read?: AccessFilter | AccessFilter[]
  /** Field whitelist for reads. An empty list exposes only `_id`. */
  read_fields?: string[]
  /**
   * Row filter for writes: `{}` — all rows. Checked against the existing
   * document for update/remove and the new document for add.
   */
  write?: AccessFilter | AccessFilter[]
  /** Field whitelist for writes. An empty list permits no client field paths. */
  write_fields?: string[]
}

/**
 * Access object merged from the user's groups at login, e.g.
 * `{ zad: { read: {}, write: {} }, bill: { read: { needact: true }, read_fields: ["fio"] } }`.
 * The only flag value is the special `fullaccess: 1` key.
 */
export type UserAccess = { fullaccess?: 1 | true } & Record<string, AccessTableEntry | 1 | true | undefined>

/** User identity passed into every access decision. */
export interface AccessUser {
  _id: string
  login?: string
  groups?: string[]
  /** Merged access object (groups + personal), attached at login. */
  access?: UserAccess
  emailVerified?: boolean
  phoneVerified?: boolean
}

/** Context object passed into every hook and access check. */
export interface AccessContext<T extends BaseDoc = BaseDoc> {
  /** Original RPC request the access check runs for (may be undefined for internal calls). */
  req?: unknown
  /** Resolved user, or `undefined` for anonymous calls. */
  user?: AccessUser
  /** Table the access check runs against. */
  table: string
  /**
   * Which operation triggered the check. Always present for calls that go
   * through the built-in methods, so a rule can branch on it.
   */
  method?: "load" | "getIds" | "getUnique" | "count" | "sync" | "add" | "update" | "remove"
  /** Document id. */
  id: string
  /** Alias of `id` (`docId` is provided for ergonomics in user code). */
  docId: string
  /** Current document state (post-update for writes, current for reads). May be undefined for inserts. */
  obj?: T
  /** Previous document state (for `update` and `delete` only). */
  old?: T
  /** New field values for the requested write. */
  set?: Partial<T> & Record<string, unknown>
  /** Field paths to unset for the requested write. */
  unset?: string[]
  /** Change being checked when this rule is invoked from sync. */
  change?: Change<T>
  /** Action type when invoked from sync filtering. */
  action?: Change<T>["action"]
  /** Client filter of the current request (`getIds`, `count`, `getUnique`). */
  filter?: Record<string, unknown>
  /** Requested sort (`getIds`). */
  sort?: Record<string, 1 | -1>
  /** Requested pagination (`getIds`). */
  skip?: number
  /** Requested page size, `0` meaning no limit (`getIds`). */
  limit?: number
  /** Field whose unique values were requested (`getUnique`). */
  field?: string
  /**
   * Field whitelist for this request. A `beforeRead` hook may set it to narrow
   * the returned fields; it can only narrow the group's `read_fields`, never
   * widen them. An empty list keeps only `_id`.
   */
  fields?: string[]
  /** Rows returned by the query (`getIds`), available in `afterRead`. */
  rows?: T[]
  /** Result that will be sent to the client. `afterRead` / `afterWrite` may replace it. */
  result?: unknown
  /** Session id of the writing client (`add`, `update`, `remove`, `sync`). */
  sessionId?: string
  /** Id of the acting user, or `systemUserId` for server-side writes. */
  actorId?: string
  /** Server timestamp of the current write. */
  now?: string
  /** Error that aborted the operation. Only in `errorRead` / `errorWrite`. */
  error?: Error
  /** Lazy loader returning the current document. Available in sync; loads from Mongo on first call. */
  loadDoc?: () => Promise<T | undefined>
}

/** Decision after normalisation. */
export interface AccessDecision {
  allowed: boolean
  fields?: string[]
}

/**
 * Returns true when a merged access object grants the action on the table.
 * Without `doc` a filter counts as "has some access"; pass a document
 * (and the user for placeholders) to test a concrete row.
 */
export function accessAllows(
  access: UserAccess | undefined,
  table: string | undefined,
  action: "read" | "write",
  doc?: unknown,
  user?: AccessUser
): boolean

/** Returns true when a document matches an access filter (placeholders resolved against `user`). */
export function matchesAccessFilter(
  doc: unknown,
  filter: AccessFilter,
  user?: AccessUser
): boolean

/** Throws `Read denied: <table>` / `Write denied: <table>` if the decision says no. */
export function assertAccess<T extends BaseDoc = BaseDoc>(
  config: unknown,
  action: "read" | "write",
  ctx: AccessContext<T>
): Promise<AccessDecision>

/** Returns the decision from the user's group access (allowed + optional fields). */
export function resolveAccess<T extends BaseDoc = BaseDoc>(
  config: unknown,
  action: "read" | "write",
  ctx: AccessContext<T>
): Promise<AccessDecision>

/** Throws `${label} denied: field <path>` when a path is outside `access.fields`. */
export function assertFieldsAccess(
  access: AccessDecision,
  paths: ReadonlyArray<string>,
  label?: string
): void

/** Projects an object to the supplied field whitelist (always keeps `_id`). */
export function projectFields<T extends BaseDoc>(obj: T | null | undefined, fields?: string[]): T | null | undefined

/** Extracts every dot-path that a change touches. Used for field-level write checks. */
export function changeWritePaths(change: Pick<Change, "set" | "unset" | "obj">): string[]

/** Returns the change with `set`/`unset`/`obj`/`old` filtered to the supplied field whitelist. */
export function filterChangeFields<T extends BaseDoc>(change: Change<T>, fields?: string[]): Change<T> | undefined

/** Returns true when a dot-path is inside a field whitelist. */
export function isAllowedField(path: string, fields: string[]): boolean

/** Resolves the calling user via the configured `getUser` hook. */
export function resolveUser(config: unknown, ctx: AccessContext): Promise<AccessUser | undefined>
