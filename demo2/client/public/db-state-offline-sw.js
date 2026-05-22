const CACHE_NAME = "db-state-demo2-v2"
const APP_SHELL = ["/", "/index.html"]
const NETWORK_GRACE_MS = 80

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  const url = new URL(request.url)

  if (request.method !== "GET" || url.origin !== location.origin) return

  if (request.mode === "navigate") {
    event.respondWith(cacheFastNetworkGrace(request, "/index.html"))
    return
  }

  if (url.search || url.href.includes("-noCache")) return

  event.respondWith(cacheFastNetworkGrace(request))
})

async function cacheFastNetworkGrace(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME)
  let response

  const cached = cache.match(request).then((cachedResponse) => {
    if (cachedResponse) response = cachedResponse
  })

  const network = fetch(request.clone())
    .then((response) => {
      if (response.status < 400) {
        cache.put(request, response.clone())
        response = response.clone()
      }
      return response
    })
    .catch(() => undefined)

  await Promise.race([cached, network])
  await Promise.race([sleep(NETWORK_GRACE_MS), network])

  if (response) return response

  await cached
  if (response) return response

  const networkResponse = await network
  if (networkResponse) return networkResponse

  if (fallbackUrl) return await cache.match(fallbackUrl)
  return Response.error()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
