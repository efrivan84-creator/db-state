import type { ComputedRef, Ref } from "vue"

/** Number of pending loads tracked for a single page-level key. */
export type LoadingCount = number

/**
 * Vue ref returned by `state.getKeyRef(key)`. Its value is the number of
 * outstanding loads tied to that page-level key. The `.ready` computed
 * is `true` when all loads have finished.
 */
export interface LoadingKeyRef extends Ref<LoadingCount> {
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
