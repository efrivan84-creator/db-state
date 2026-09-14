import { stat } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { reloadCheckMs } from "./file-cache.js"

// File-based RPC methods: method name maps to a file inside the configured
// directory ("zad.get-num" -> <dir>/zad/get-num.js), the file's default export
// is the handler. Files are imported lazily on first call and re-imported when
// the file mtime changes, so edits apply without a server restart.
//
// Re-import uses a cache-busting query (?v=mtime): old module copies stay in
// memory (ESM cannot evict), which is negligible in practice — production
// files do not change, development reloads are small.

const SEGMENT_RE = /^[a-z0-9][a-z0-9_-]*$/

// Папка публичных методов: rpc/pub/... вызывается без входа.
//
// Регистрация и восстановление пароля не выражаются обычным методом: чтобы
// позвать обычный, нужна сессия, а это как раз то, чего у человека нет.
//
// Признак — папка, а не список в конфиге и не префикс в имени файла.
// Папку видно в дереве, и «что открыто наружу» отвечается одним `ls rpc/pub`.
// Префикс в имени пришлось бы повторять у каждого файла, и опечатка в нём
// молча меняла бы доступ; здесь промахнуться мимо папки невозможно —
// файл либо лежит в ней, либо нет.
//
// Имя метода у клиента тоже начинается с pub: "pub.auth.register". Видно и
// в браузере, и в логах, что вызов идёт в открытую часть.
const PUBLIC_SEGMENT = "pub"

export function createMethodsDirResolver(dir, context = {}, checkMs) {
  const every = reloadCheckMs(checkMs)
  const base = baseUrl(dir)
  const cache = new Map()

  return async function resolve(method) {
    const url = methodFileUrl(base, method)
    if (!url) return undefined

    const cached = cache.get(url.href)
    // Свежесть файла проверяем не чаще RELOAD_CHECK_MS: иначе каждый вызов
    // метода начинался бы с обращения к диску.
    if (cached && Date.now() - cached.checkedAt < every) return cached.handler

    let info
    try {
      info = await stat(url)
    } catch {
      return undefined
    }
    if (!info.isFile()) return undefined

    if (cached && cached.mtimeMs === info.mtimeMs) {
      cached.checkedAt = Date.now()
      return cached.handler
    }

    const module = await import(url.href + "?v=" + info.mtimeMs)
    if (typeof module.default !== "function") {
      throw new Error(`RPC method file must export default a function: ${method}`)
    }

    const handler = (req) => module.default({ ...req, ...context, user: req.client?.user })
    cache.set(url.href, { mtimeMs: info.mtimeMs, checkedAt: Date.now(), handler })
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

// Публичный ли метод — по первому сегменту имени, то есть по папке, в
// которой лежит файл. Проверка отдельно от разбора пути: её зовёт rpc.js
// до того, как метод вообще станут искать на диске.
export function isPublicMethod(method) {
  return String(method ?? "").split(".")[0] === PUBLIC_SEGMENT
}

// "zad.get-num" -> <dir>/zad/get-num.js; every segment is validated so a
// client-supplied name can never leave the directory.
function methodFileUrl(base, method) {
  const segments = String(method ?? "").split(".")
  if (segments.length === 0 || !segments.every((segment) => SEGMENT_RE.test(segment))) return undefined
  return new URL(segments.join("/") + ".js", base)
}
