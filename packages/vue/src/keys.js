import { computed, ref } from "vue"

export function getKeyRef(keyRefs, key) {
  if (!keyRefs.has(key)) {
    const pending = ref(0)
    pending.ready = computed(() => pending.value === 0)
    keyRefs.set(key, pending)
  }

  return keyRefs.get(key)
}

export function trackPendingKey({ key, loadingByKey, keyRefs, token }) {
  if (!key) return
  if (!loadingByKey.has(key)) loadingByKey.set(key, new Set())
  const set = loadingByKey.get(key)
  if (set.has(token)) return
  set.add(token)
  getKeyRef(keyRefs, key).value = set.size
}

export function trackLoadedKey({ key, loadingByKey, keyRefs, token }) {
  if (!key) return
  const set = loadingByKey.get(key)
  if (!set) return
  set.delete(token)
  getKeyRef(keyRefs, key).value = set.size
}
