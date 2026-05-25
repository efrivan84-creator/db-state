import { computed, shallowReactive } from "vue"

export function getKeyRef(keyRefs, key) {
  if (!keyRefs.has(key)) {
    const loading = shallowReactive({
      value: 0,
      max: 0,
      start: false,
      get percent() {
        return this.max > 0 ? (this.value / this.max) * 100 : 0
      }
    })
    loading.ready = computed(() => loading.value === 0)
    keyRefs.set(key, loading)
  }

  return keyRefs.get(key)
}

export function trackPendingKey({ key, loadingByKey, keyRefs, token }) {
  if (!key) return
  if (!loadingByKey.has(key)) loadingByKey.set(key, new Set())
  const set = loadingByKey.get(key)
  if (set.has(token)) return
  set.add(token)
  const loading = getKeyRef(keyRefs, key)
  loading.value = set.size
  loading.max = Math.max(loading.max, set.size)
  if (set.size > 0) loading.start = true
}

export function trackLoadedKey({ key, loadingByKey, keyRefs, token }) {
  if (!key) return
  const set = loadingByKey.get(key)
  if (!set) return
  set.delete(token)
  const loading = getKeyRef(keyRefs, key)
  loading.value = set.size
  if (set.size === 0) loading.max = 0
}
