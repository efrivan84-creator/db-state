/**
 * @db-state/core — shared protocol, change shape, dot-path helpers.
 *
 * This package is consumed by both the Vue client and the Mongo server,
 * so it has zero runtime dependencies.
 */

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** Prefix reserved for library-internal WebSocket events. User events MUST NOT start with this. */
export const DB_STATE_EVENT_PREFIX: "dbstate:"

/** Names of the library-internal WebSocket events. */
export const DB_STATE_EVENTS: Readonly<{
  /** Sent by the server right after a client connects. */
  hello: "dbstate:hello"
  /** Sent by the server when new changes are available in the log. Clients should call sync. */
  changesAvailable: "dbstate:changes_available"
  /** Sent by the server when clients must drop their local `time1` and resync from epoch. */
  forceResync: "dbstate:force_resync"
  /** Generic server-side error event. */
  error: "dbstate:error"
}>

/** Names of the service tables added automatically by both the client and the server. */
export const SERVICE_TABLES: ReadonlyArray<"_user" | "_group" | "_permission">

// ---------------------------------------------------------------------------
// Document and change shape
// ---------------------------------------------------------------------------

/** Generic shape that every document in db-state must satisfy. */
export interface BaseDoc {
  _id: string
  /** Optional mirror of `_id` for legacy paths. The library writes both. */
  id?: string
}

/** The three actions stored in the log. */
export type ChangeAction = "insert" | "update" | "delete"

/**
 * A single entry in the append-only log.
 *
 * @template T  Shape of the document the change relates to.
 */
export interface Change<T extends BaseDoc = BaseDoc> {
  /** Unique change id. Generated server-side. */
  logId: string
  /** ISO timestamp the server assigned when writing the log entry. */
  createdAt: string
  /** Table the change applies to. */
  table: string
  /** Document id the change applies to. */
  id: string
  /** Which operation happened. */
  action: ChangeAction
  /**
   * For `update`: dot-path → value map of fields that were set.
   * Falls back to `objedit` for legacy callers; both forms are merged when applied.
   */
  set?: Partial<T> & Record<string, unknown>
  /** For `update`: dot-paths of fields that were removed. */
  unset?: string[]
  /** For `insert`: the full document that was inserted. */
  obj?: T
  /** For `delete`: the full document that was removed (needed for permission checks in sync). */
  old?: T
  /** Session that originated the change. Used by sync to skip echoing back to its source. */
  sessionId?: string
  /** User id that originated the change (audit trail). */
  userId?: string
}

/** Convenience alias for code dealing with logs of arbitrary tables. */
export type AnyChange = Change<BaseDoc>

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/** Adds service tables (`_user`, `_group`, `_permission`) to the supplied list and dedups. */
export function normalizeTables<T extends readonly string[]>(
  tables: T
): Array<T[number] | (typeof SERVICE_TABLES)[number]>

/** Generates a session id of the form `${userId}_${random10}`. */
export function createSessionId(
  userId?: string,
  random?: (length: number) => string
): string

/**
 * Fills in missing fields on a partial change object (logId, createdAt).
 * Used by the server when appending to the log.
 */
export function createChange<T extends BaseDoc>(change: Partial<Change<T>> & Pick<Change<T>, "table" | "id" | "action">): Change<T>

/** Filters a log slice by `(from, to]` window and excludes a given session. */
export function filterSyncChanges(
  changes: ReadonlyArray<Change>,
  options: { from: string; to: string; sessionId?: string }
): Change[]

/** Stable change comparator: primary by `createdAt`, secondary by `logId`. */
export function compareChanges(a: Change, b: Change): number

/**
 * Applies a change to a `tables[tableName][id]` map in place.
 * Used by client-side reactive stores and by tests.
 */
export function applyChange(
  tables: Record<string, Record<string, unknown>>,
  change: Change
): void

/** Applies the set/unset portion of a change to an arbitrary target object. */
export function applyPatch<T extends object>(target: T, change: Pick<Change, "set" | "unset"> & { objedit?: Change["set"] }): T

/** Dot-path setter. Creates intermediate objects as needed. */
export function setByPath<T extends object>(target: T, path: string, value: unknown): T

/** Dot-path getter. Returns `undefined` for missing paths. */
export function getByPath(target: unknown, path: string): unknown

/** Dot-path deleter. No-op for missing paths. */
export function unsetByPath<T extends object>(target: T, path: string): T

/** Returns `true` if the given message type belongs to the library's reserved namespace. */
export function isDbStateEvent(type: string): boolean
