import { readdir, stat } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { reloadCheckMs } from "./file-cache.js"

// Хуки файлами: hooks/beforeRead.js — для всех таблиц,
// hooks/<таблица>/beforeRead.js — только для своей.
//
// Отличие от методов-файлов: метод ищут, когда его позвали по имени, а хук
// нужен на каждой операции. Проверять существование файла запросом к ФС
// значит платить за это всегда, в том числе там, где хуков нет вовсе.
// Поэтому состав папки читается один раз при старте, а дальше в ФС ходим
// только к найденным файлам — свериться с mtime и перечитать при правке.
//
// Следствие: правка существующего файла применяется на лету, а новый файл
// подхватывается после перезапуска. Так же ведут себя маршруты в большинстве
// серверных фреймворков.

const HOOK_NAMES = [
  "beforeRead",
  "afterRead",
  "errorRead",
  "beforeWrite",
  "afterWrite",
  "errorWrite"
]

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/


// Читает состав папки и возвращает объект хуков:
// { beforeRead: fn, beforeWrite: fn, ... }. Для каждого имени — одна функция,
// внутри которой сначала общий файл, затем файл нужной таблицы.
export async function loadHooksDir(dir, checkMs) {
  const every = reloadCheckMs(checkMs)
  const base = baseUrl(dir)
  const found = await scanHooksDir(base)
  const out = {}

  for (const name of HOOK_NAMES) {
    const shared = found.shared.get(name)
    const byTable = found.byTable.get(name)
    if (!shared && !byTable) continue

    out[name] = createHookRunner(name, shared, byTable, every)
  }

  return out
}

// Один проход по папке: корневые файлы — общие хуки, подпапки — таблицы.
async function scanHooksDir(base) {
  const shared = new Map()
  const byTable = new Map()

  for (const entry of await readDirSafe(base)) {
    if (entry.isFile()) {
      const name = hookNameOf(entry.name)
      if (name) shared.set(name, new URL(entry.name, base))
      continue
    }

    if (!entry.isDirectory() || !SEGMENT_RE.test(entry.name)) continue

    const tableBase = new URL(`${entry.name}/`, base)
    for (const file of await readDirSafe(tableBase)) {
      if (!file.isFile()) continue
      const name = hookNameOf(file.name)
      if (!name) continue

      if (!byTable.has(name)) byTable.set(name, new Map())
      byTable.get(name).set(entry.name, new URL(file.name, tableBase))
    }
  }

  return { shared, byTable }
}

// Общий хук идёт первым, табличный — вторым: первое явное решение
// останавливает цепочку, как и у хуков модулей.
function createHookRunner(name, sharedUrl, tableUrls, every) {
  const cache = new Map()

  return async function runFileHooks(ctx) {
    if (sharedUrl) {
      const decision = await callHook(cache, sharedUrl, name, ctx, every)
      if (decision !== undefined && decision !== null) return decision
    }

    const tableUrl = tableUrls?.get(ctx.table)
    if (!tableUrl) return undefined

    return callHook(cache, tableUrl, name, ctx, every)
  }
}

async function callHook(cache, url, name, ctx, every) {
  const handler = await loadHook(cache, url, name, every)
  return handler ? handler(ctx) : undefined
}

// Тот же приём, что у методов-файлов: mtime как ключ кэша, ?v= для сброса
// ESM-кэша. Файл, удалённый после старта, просто перестаёт вызываться.
async function loadHook(cache, url, name, every) {
  const cached = cache.get(url.href)
  // Хук вызывается на каждой операции, поэтому stat на каждый вызов был бы
  // самой дорогой частью хука. Свежесть файла проверяем не чаще RELOAD_CHECK_MS.
  if (cached && Date.now() - cached.checkedAt < every) return cached.handler

  let info
  try {
    info = await stat(url)
  } catch {
    return undefined
  }

  if (cached && cached.mtimeMs === info.mtimeMs) {
    cached.checkedAt = Date.now()
    return cached.handler
  }

  const module = await import(url.href + "?v=" + info.mtimeMs)
  if (typeof module.default !== "function") {
    throw new Error(`Hook file must export default a function: ${url.pathname} (${name})`)
  }

  cache.set(url.href, { mtimeMs: info.mtimeMs, checkedAt: Date.now(), handler: module.default })
  return module.default
}

async function readDirSafe(url) {
  try {
    return await readdir(url, { withFileTypes: true })
  } catch {
    return []
  }
}

// "beforeRead.js" -> "beforeRead"; всё остальное в папке игнорируется,
// чтобы README.md или вспомогательный файл рядом не ломали загрузку.
function hookNameOf(fileName) {
  if (!fileName.endsWith(".js")) return undefined
  const name = fileName.slice(0, -3)
  return HOOK_NAMES.includes(name) ? name : undefined
}

function baseUrl(dir) {
  const url = dir instanceof URL
    ? new URL(dir.href)
    : String(dir).startsWith("file:") ? new URL(dir) : pathToFileURL(String(dir))
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url
}
