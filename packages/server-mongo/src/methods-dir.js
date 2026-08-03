import { stat } from "node:fs/promises"
import { pathToFileURL } from "node:url"

// File-based RPC methods: method name maps to a file inside the configured
// directory ("zad.get-num" -> <dir>/zad/get-num.js), the file's default export
// is the handler. Files are imported lazily on first call and re-imported when
// the file mtime changes, so edits apply without a server restart.
//
// Re-import uses a cache-busting query (?v=mtime): old module copies stay in
// memory (ESM cannot evict), which is negligible in practice — production
// files do not change, development reloads are small.

const SEGMENT_RE = /^[a-z0-9][a-z0-9_-]*$/

export function createMethodsDirResolver(dir, context = {}) {
  const base = baseUrl(dir)
  const cache = new Map()

  return async function resolve(method) {
    const url = methodFileUrl(base, method)
    if (!url) return undefined

    let info
    try {
      info = await stat(url)
    } catch {
      return undefined
    }
    if (!info.isFile()) return undefined

    const cached = cache.get(url.href)
    if (cached && cached.mtimeMs === info.mtimeMs) return cached.handler

    const module = await import(url.href + "?v=" + info.mtimeMs)
    if (typeof module.default !== "function") {
      throw new Error(`RPC method file must export default a function: ${method}`)
    }

    const handler = (req) => module.default({ ...req, ...context, user: req.client?.user })
    cache.set(url.href, { mtimeMs: info.mtimeMs, handler })
    return handler
  }
}

// Accepts a file URL or a plain filesystem path; the trailing slash matters
// for URL resolution, so it is enforced here.
function baseUrl(dir) {
  const url = dir instanceof URL
    ? new URL(dir.href)
    : String(dir).startsWith("file:") ? new URL(dir) : pathToFileURL(String(dir))
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url
}

// "zad.get-num" -> <dir>/zad/get-num.js; every segment is validated so a
// client-supplied name can never leave the directory.
function methodFileUrl(base, method) {
  const segments = String(method ?? "").split(".")
  if (segments.length === 0 || !segments.every((segment) => SEGMENT_RE.test(segment))) return undefined
  return new URL(segments.join("/") + ".js", base)
}
