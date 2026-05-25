import type { ComputedRef } from "vue"

/** Reactive loading state returned by `state.getKeyRef(key)`. */
export interface LoadingKeyRef {
  /** Current number of active operations tied to this key. */
  value: number
  /** Highest `value` reached during the current loading wave; reset to 0 when `value` returns to 0. */
  max: number
  /** `false` until the first operation starts, then `true` until `resetKey(key)`. */
  start: boolean
  /** `value / max * 100`, or 0 when `max` is 0. */
  readonly percent: number
  /** Backward-compatible ready flag: true when `value === 0`. */
  ready: ComputedRef<boolean>
}

export function getKeyRef(
  keyRefs: Map<string, LoadingKeyRef>,
  key: string
): LoadingKeyRef

export function trackPendingKey(input: {
  key: string | undefined
  loadingByKey: Map<string, Set<string>>
  keyRefs: Map<string, LoadingKeyRef>
  token: string
}): void

export function trackLoadedKey(input: {
  key: string | undefined
  loadingByKey: Map<string, Set<string>>
  keyRefs: Map<string, LoadingKeyRef>
  token: string
}): void
