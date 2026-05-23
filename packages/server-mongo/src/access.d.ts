import type { BaseDoc, Change, PermissionPart, ServicePermission } from "@db-state/core"

export type { PermissionPart } from "@db-state/core"

/** User identity passed into every access decision. */
export interface AccessUser {
  _id: string
  login?: string
  groups?: string[]
}

/** Context object passed into every code-level access rule. */
export interface AccessContext<T extends BaseDoc = BaseDoc> {
  /** Original RPC request the access check runs for (may be undefined for internal calls). */
  req?: unknown
  /** Resolved user, or `undefined` for anonymous calls. */
  user?: AccessUser
  /** Table the access check runs against. */
  table: string
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
  /** Lazy loader returning the current document. Available in sync; loads from Mongo on first call. */
  loadDoc?: () => Promise<T | undefined>
  /** Pre-fetched `_permission` rules for this table (passed through by sync to avoid N+1). */
  permissionRules?: ServerPermissionRule<T>[]
}

/** Document shape stored in the `_permission` table. */
export type ServerPermissionRule<T extends BaseDoc = BaseDoc> = ServicePermission<T>

/** What a single access rule can return. */
export type AccessDecisionValue =
  | boolean
  | { allowed: boolean; fields?: string[] }
  | { action: boolean; fields?: string[] }
  | { fields?: string[] }
  | null
  | undefined

/** User-defined access rule callback. */
export type AccessRule<T extends BaseDoc = BaseDoc> =
  (ctx: AccessContext<T>) => AccessDecisionValue | Promise<AccessDecisionValue>

/** Decision after normalisation. */
export interface AccessDecision {
  allowed: boolean
  fields?: string[]
}

/** Shape accepted by `createDbStateServer({ access })`. */
export interface AccessConfig {
  /** Per-(table, id) rules. */
  doc?: Record<string, Record<string, { read?: AccessRule<any>; write?: AccessRule<any> }>>
  /** Per-table rules. */
  table?: Record<string, { read?: AccessRule<any>; write?: AccessRule<any> }>
}

/** Throws `Read denied` / `Write denied` if the decision says no. */
export function assertAccess<T extends BaseDoc = BaseDoc>(
  config: unknown,
  action: "read" | "write",
  ctx: AccessContext<T>
): Promise<AccessDecision>

/** Returns `true` when access is allowed; never throws. */
export function canAccess<T extends BaseDoc = BaseDoc>(
  config: unknown,
  action: "read" | "write",
  ctx: AccessContext<T>
): Promise<boolean>

/** Returns the normalised decision (allowed + optional fields). */
export function resolveAccess<T extends BaseDoc = BaseDoc>(
  config: unknown,
  action: "read" | "write",
  ctx: AccessContext<T>
): Promise<AccessDecision>

/** Filters an array of documents down to those readable by the caller. */
export function filterReadable<T extends BaseDoc>(
  config: unknown,
  req: unknown,
  table: string,
  rows: T[]
): Promise<T[]>

/** Throws `${label} denied: field <path>` when a path is outside `access.fields`. */
export function assertFieldsAccess(
  access: AccessDecision,
  paths: ReadonlyArray<string>,
  label?: string
): void

/** Projects an object to the supplied field whitelist (always keeps `_id` / `id`). */
export function projectFields<T extends BaseDoc>(obj: T | null | undefined, fields?: string[]): T | null | undefined

/** Extracts every dot-path that a change touches. Used for field-level write checks. */
export function changeWritePaths(change: Pick<Change, "set" | "unset" | "obj">): string[]

/** Returns the change with `set`/`unset`/`obj`/`old` filtered to the supplied field whitelist. */
export function filterChangeFields<T extends BaseDoc>(change: Change<T>, fields?: string[]): Change<T> | undefined

/** Resolves the calling user via the configured `getUser` hook. */
export function resolveUser(config: unknown, ctx: AccessContext): Promise<AccessUser | undefined>
