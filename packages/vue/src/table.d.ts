import type { ComputedRef, Ref } from "vue"

import type { BaseDoc, Change, Filter, ListQuery, UpdateArgs } from "@db-state/core"

export type { Filter, ListQuery, SortSpec, UpdateArgs } from "@db-state/core"

/** Optional page-level key used to track loading state across multiple `load`/`listRef` calls. */
export type PageKey = string | undefined

/** Reactive document returned by `load` / `listRef`. */
export type ReactiveDoc<T extends BaseDoc> = T & {
  /** `true` once the document has been loaded from cache or server. */
  __loaded?: boolean
  /** `true` once the local cache lookup has completed. */
  __cacheChecked?: boolean
}

/** Result of any CRUD RPC. */
export interface MutationResult<T extends BaseDoc> {
  ok: true
  /** For `add`: the server-assigned (or echoed) id. */
  id?: string
  /** The change appended to the log and broadcast to other sessions. */
  change: Change<T>
}

/** Returned by change-hook registration methods. Call it to unsubscribe. */
export type ChangeUnsubscribe = () => void

/** Callback for every visible change in one table. */
export type TableChangeHandler<T extends BaseDoc = BaseDoc> = (change: Change<T>) => void

/** Callback for inserted documents. */
export type TableAddHandler<T extends BaseDoc = BaseDoc> = (obj: ReactiveDoc<T> | undefined, change: Change<T>) => void

/** Callback for updated documents. `obj` is undefined when an unloaded row receives an update. */
export type TableEditHandler<T extends BaseDoc = BaseDoc> = (obj: ReactiveDoc<T> | undefined, change: Change<T>) => void

/** Callback for deleted documents. Uses `change.old` when present, otherwise the local loaded object. */
export type TableDeleteHandler<T extends BaseDoc = BaseDoc> = (oldObj: T | ReactiveDoc<T> | undefined, change: Change<T>) => void

/**
 * Per-table reactive API. One instance per table is created lazily when
 * `state[tableName]` is accessed.
 *
 * @template T  Document shape for this table (must extend `BaseDoc`).
 */
export interface TableApi<T extends BaseDoc = BaseDoc> {
  /** Live reactive map of every document the page has loaded so far. */
  readonly items: Record<string, ReactiveDoc<T>>

  /** Map of `id → Error` for the most recent failed `load`/`getAsync`. */
  readonly errors: Record<string, Error>

  /** Registers a callback for every applied change in this table. */
  onChange(callback: TableChangeHandler<T>): ChangeUnsubscribe

  /** Registers a callback for inserted documents in this table. */
  onAdd(callback: TableAddHandler<T>): ChangeUnsubscribe

  /** Registers a callback for updated documents in this table. */
  onEdit(callback: TableEditHandler<T>): ChangeUnsubscribe

  /** Registers a callback for deleted documents in this table. */
  onDelete(callback: TableDeleteHandler<T>): ChangeUnsubscribe

  /**
   * Returns a reactive document by id, loading it from cache/server in the
   * background if necessary. Optionally tracks loading under `key`.
   *
   * Returns `undefined` only when `id` is nullish; otherwise always returns
   * a reactive object whose `__loaded` flag flips to `true` once data
   * arrives.
   */
  load(id: string, key?: PageKey): ReactiveDoc<T>
  load(id: null | undefined, key?: PageKey): undefined

  /**
   * Promise-based variant of `load` that resolves once the document is
   * loaded or the load fails. If auth is not ready after a cache miss, it
   * waits until auth is restored because the result is not reactive.
   * Resolves with `undefined` on error.
   */
  getAsync(id: string, key?: PageKey): Promise<ReactiveDoc<T> | undefined>

  /**
   * Fetches a list of ids matching the query directly from the server
   * (no caching, no reactivity). Waits for authorization before RPC.
   * Use `idsRef` for reactive needs.
   */
  getIds(query?: ListQuery<T>, key?: PageKey): Promise<string[]>

  /** Fetches distinct values for a single field on the server. Waits for authorization before RPC. */
  getUnique<V = unknown>(
    query: { field: keyof T & string; filter?: Filter<T> },
    key?: PageKey
  ): Promise<V[]>

  /**
   * Returns a reactive ref of the server-side count for `filter`.
   * Refs are deduplicated by stringified filter — calling twice with the
   * same shape returns the same ref. Cached value is restored from
   * IndexedDB before the first server refresh.
   */
  countRef(filter?: Filter<T>): Ref<number>

  /**
   * Returns a reactive ref of ids matching `query`. Deduplicated and
   * cached on disk; refreshes after authenticated sync or local writes.
   */
  idsRef(query?: ListQuery<T>): Ref<string[]>

  /**
   * Returns a computed list of reactive documents — combines
   * {@link idsRef} with {@link load}. Each item is a `ReactiveDoc<T>`.
   */
  listRef(query?: ListQuery<T>, key?: PageKey): ComputedRef<ReactiveDoc<T>[]>

  /** Sends an update RPC and applies the resulting change locally. */
  update(args: UpdateArgs<T>): Promise<MutationResult<T>>

  /** Sends an insert RPC and applies the resulting change locally. */
  add(obj: Partial<T> & { _id?: string; id?: string }): Promise<MutationResult<T>>

  /** Sends a delete RPC and applies the resulting change locally. */
  remove(id: string): Promise<MutationResult<T>>

  /** Returns the error from the latest failed load for `id`, if any. */
  getError(id: string): Error | undefined

  /** Returns `true` while `load(id)` is in flight. */
  isLoading(id: string): boolean
}
