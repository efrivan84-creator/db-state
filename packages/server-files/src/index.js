import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"

import { createPrefixedTableName, normalizeServicePrefix } from "@db-state/core"

const DEFAULT_CHUNK_SIZE = 512 * 1024
const DEFAULT_MAX_SIZE = 50 * 1024 * 1024
// Поля таблицы файлов, которые можно отдавать клиенту. storageKey сюда не
// входит: путь в хранилище не должен покидать сервер. sha256 — тоже: при
// дедупликации хэш сам открывает файл (см. startUpload), он такой же ключ,
// как token, и отдавать его наружу нельзя.
//
// Экспортируется, чтобы hooksDir-версия защиты не переписывала список вручную
// и не разъезжалась с библиотекой — см. hooks в module ниже.
export const FILE_FIELDS = ["ownerId", "token", "name", "mime", "size", "status", "downloadPolicy", "info"]

export function createFileModule(input = {}) {
  const options = normalizeOptions(input)
  const uploads = new Map()
  const downloads = new Map()
  let api
  let config

  const module = {
    table: options.table,
    tables: [options.table],
    // Загрузка и скачивание идут через сам модуль, а не через CRUD: такие
    // вызовы помечены internalReq и проходят без прав группы. Всё остальное
    // подчиняется обычному access группы на таблице файлов, например
    //   { file: { read: { ownerId: "$adminid" }, read_fields: [...] } }
    //
    // Это хуки модуля: библиотека вызывает их до файловых хуков приложения,
    // независимо от hooksDir. Переносить их в папку не нужно.
    hooks: {
      beforeRead: (ctx) => {
        if (ctx.table !== options.table) return
        // storageKey не покидает сервер даже при внутреннем чтении.
        ctx.fields = FILE_FIELDS
        if (ctx.req?.__dbStateFileInternal) return true
      },

      // sync: beforeRead на изменения не вызывается, и без этого хука
      // изменение строки файла ушло бы как есть — со storageKey и sha256.
      // Кто получает изменение, по-прежнему решает право группы.
      readChange: (ctx) => {
        if (ctx.table !== options.table) return
        ctx.fields = FILE_FIELDS
      },

      beforeWrite: (ctx) => {
        if (ctx.table !== options.table) return
        // Прямая правка метаданных запрещена: только через файловый API.
        return ctx.req?.__dbStateFileInternal === true
          ? true
          : { allowed: false, reason: "File metadata is managed by the file API" }
      }
    },

    bind(context) {
      api = context.api
      config = context.config
      options.storage.bind?.(context)
    },

    async handleMessage(client, message) {
      if (!String(message.type ?? "").startsWith("dbfile:")) return false

      try {
        if (message.type === "dbfile:upload_start") await startUpload(client, message)
        else if (message.type === "dbfile:download_start") await startDownload(client, message)
        else if (message.type === "dbfile:download_next") await continueDownload(client, message)
        else sendJson(client, { type: "dbfile:error", id: message.id, error: `Unknown file message: ${message.type}` })
      } catch (error) {
        sendJson(client, { type: "dbfile:error", id: message.id, error: error.message })
      }

      return true
    },

    async handleRawMessage(client, raw) {
      const upload = uploads.get(client)
      if (!upload) return
      try {
        await receiveUploadChunk(client, raw, upload)
      } catch (error) {
        await failUpload(client, upload)
        sendJson(client, { type: "dbfile:error", id: upload.id, error: error.message })
      }
    },

    async handleClose(client) {
      const upload = uploads.get(client)
      downloads.delete(client)
      if (upload) await failUpload(client, upload)
    },

    withServicePrefix(prefix) {
      if (input.table || input.servicePrefix != null || input.prefix != null) return module
      const servicePrefix = normalizeServicePrefix({ servicePrefix: prefix })
      if (!servicePrefix) return module
      return createFileModule({ ...input, servicePrefix })
    }
  }

  async function startUpload(client, message) {
    if (!client.user) throw new Error("Unauthorized")

    const size = Number(message.size ?? 0)
    if (!Number.isFinite(size) || size < 0) throw new Error("Invalid file size")
    if (size > options.maxSize) throw new Error("File too large")
    if (uploads.has(client)) throw new Error("Upload already active")

    const uploadId = safeId(message.id ?? createId("upload"))
    const fileId = createId("file")
    const policy = message.policy ?? options.defaultPolicy

    // Дедупликация: клиент прислал хэш, и такой файл уже лежит — байты не
    // принимаем, заводим новую строку на тот же бинарь со своим владельцем,
    // token и политикой. Хэш клиента — только ключ поиска: найденный sha256
    // сервер посчитал сам по байтам, поэтому подложить чужой хэш под свой
    // мусор нельзя. Цена: кто знает хэш файла, получает сам файл — поэтому
    // sha256 наружу не отдаётся никогда (FILE_FIELDS). dedupe: false выключает.
    const claimed = sha256Hex(message.sha256)
    if (claimed && options.dedupe !== false) {
      const existing = await config.mongo.collection(options.table)
        .findOne({ sha256: claimed, size, status: "ready" })
      if (existing) {
        await linkExisting(client, message, { fileId, policy, size, existing })
        return
      }
    }

    const obj = {
      _id: fileId,
      ownerId: client.userId ?? client.user._id,
      name: String(message.name ?? "file"),
      mime: String(message.mime ?? "application/octet-stream"),
      size,
      storageKey: options.storage.tmpKey(uploadId),
      status: "uploading",
      downloadPolicy: policy
    }

    await options.storage.abort({ uploadId })
    await api.add({
      table: options.table,
      obj,
      req: internalReq(client),
      sessionId: client.sessionId
    })

    // Хэш считаем сами по мере прихода кусков: он и проверяет заявленный
    // клиентом, и становится ключом дедупликации для следующих загрузок.
    const upload = { id: message.id, uploadId, fileId, offset: 0, size, claimed, hash: createHash("sha256") }
    uploads.set(client, upload)
    if (size === 0) {
      try {
        await finishUpload(client, upload)
      } catch (error) {
        await failUpload(client, upload)
        throw error
      }
      return
    }
    sendUploadNext(client, upload)
  }

  // Ссылка на уже лежащий бинарь вместо загрузки: новая строка, свои
  // ownerId, token и политика, тот же storageKey и серверный sha256.
  async function linkExisting(client, message, { fileId, policy, size, existing }) {
    const token = createToken()
    await api.add({
      table: options.table,
      obj: {
        _id: fileId,
        ownerId: client.userId ?? client.user._id,
        name: String(message.name ?? existing.name ?? "file"),
        mime: String(message.mime ?? existing.mime ?? "application/octet-stream"),
        size,
        storageKey: existing.storageKey,
        sha256: existing.sha256,
        status: "ready",
        downloadPolicy: policy,
        token
      },
      req: internalReq(client),
      sessionId: client.sessionId
    })
    const file = await api.load({ table: options.table, id: fileId, req: internalReq(client) })
    sendJson(client, {
      type: "dbfile:upload_done",
      id: message.id,
      fileId,
      token,
      file,
      deduplicated: true
    })
  }

  async function receiveUploadChunk(client, raw, upload) {
    const chunk = toBuffer(raw)
    if (chunk.length === 0) return
    if (upload.offset + chunk.length > upload.size) throw new Error("File chunk exceeds declared size")

    await options.storage.writeChunk({
      uploadId: upload.uploadId,
      index: upload.offset,
      offset: upload.offset,
      chunk
    })
    upload.hash.update(chunk)
    upload.offset += chunk.length

    if (upload.offset < upload.size) {
      sendUploadNext(client, upload)
      return
    }

    await finishUpload(client, upload)
  }

  async function finishUpload(client, upload) {
    const sha256 = upload.hash.digest("hex")
    // Клиент заявил один хэш, а прислал другие байты — файл повреждён в пути
    // или подменён. Такой бинарь не сохраняем: под ним искали бы дубли.
    if (upload.claimed && upload.claimed !== sha256) throw new Error("File checksum mismatch")

    const result = await options.storage.finish({ uploadId: upload.uploadId })
    let storageKey = result.storageKey
    // Такие же байты уже лежат — второй копии на диске не держим, строка
    // ссылается на прежний бинарь. Экономит место и тогда, когда клиент хэш
    // не прислал и загрузка прошла целиком.
    if (options.dedupe !== false) {
      const existing = await config.mongo.collection(options.table)
        .findOne({ sha256, size: result.size, status: "ready" })
      if (existing?.storageKey && existing.storageKey !== storageKey) {
        await options.storage.remove({ storageKey })
        storageKey = existing.storageKey
      }
    }

    const token = createToken()
    await api.update({
      table: options.table,
      id: upload.fileId,
      set: {
        status: "ready",
        storageKey,
        size: result.size,
        sha256,
        token
      },
      req: internalReq(client),
      sessionId: client.sessionId
    })

    uploads.delete(client)
    // Отдаём загрузившему его же файл: чтение внутреннее, права группы не нужны.
    const file = await api.load({ table: options.table, id: upload.fileId, req: internalReq(client) })
    sendJson(client, {
      type: "dbfile:upload_done",
      id: upload.id,
      fileId: upload.fileId,
      token,
      file
    })
  }

  async function failUpload(client, upload) {
    uploads.delete(client)
    await options.storage.abort({ uploadId: upload.uploadId }).catch(() => {})
    await api.update({
      table: options.table,
      id: upload.fileId,
      set: { status: "failed" },
      req: internalReq(client),
      sessionId: client.sessionId
    }).catch(() => {})
  }

  async function startDownload(client, message) {
    if (downloads.has(client)) throw new Error("Download already active")

    const file = await config.mongo.collection(options.table).findOne({
      token: message.token,
      status: "ready"
    })
    if (!file) throw new Error("File not found")
    assertDownloadPolicy(file.downloadPolicy ?? options.defaultPolicy, client)

    const download = {
      id: message.id,
      file,
      offset: 0,
      chunkSize: positiveInteger(message.chunkSize, options.chunkSize)
    }
    downloads.set(client, download)
    sendJson(client, {
      type: "dbfile:download_info",
      id: download.id,
      name: file.name,
      mime: file.mime,
      size: file.size
    })
    await sendDownloadChunk(client, download)
  }

  async function continueDownload(client, message) {
    const download = downloads.get(client)
    if (!download || download.id !== message.id) return
    const offset = Number(message.offset ?? download.offset)
    if (!Number.isFinite(offset) || offset < 0) throw new Error("Invalid file offset")
    download.offset = Math.min(offset, download.file.size)
    await sendDownloadChunk(client, download)
  }

  async function sendDownloadChunk(client, download) {
    if (download.offset >= download.file.size) {
      finishDownload(client, download)
      return
    }

    const end = Math.min(download.file.size, download.offset + download.chunkSize)
    const chunks = []
    for await (const chunk of options.storage.read({
      storageKey: download.file.storageKey,
      range: { start: download.offset, end }
    })) {
      chunks.push(toBuffer(chunk))
    }
    const buffer = Buffer.concat(chunks)
    client.send?.(buffer)
    download.offset = end

    if (download.offset >= download.file.size) finishDownload(client, download)
  }

  function finishDownload(client, download) {
    downloads.delete(client)
    sendJson(client, {
      type: "dbfile:download_done",
      id: download.id,
      name: download.file.name,
      mime: download.file.mime,
      size: download.file.size
    })
  }

  function sendUploadNext(client, upload) {
    sendJson(client, {
      type: "dbfile:upload_next",
      id: upload.id,
      offset: upload.offset,
      chunkSize: Math.min(options.chunkSize, upload.size - upload.offset)
    })
  }

  return module
}

export function localFileStorage(root) {
  const base = path.resolve(root)

  return {
    tmpKey(uploadId) {
      return `tmp/${safeId(uploadId)}.tmp`
    },

    async writeChunk({ uploadId, chunk }) {
      await mkdir(path.join(base, "tmp"), { recursive: true })
      await appendFile(path.join(base, this.tmpKey(uploadId)), toBuffer(chunk))
    },

    async finish({ uploadId }) {
      const name = randomBytes(16).toString("hex")
      const storageKey = `files/${name.slice(0, 2)}/${name.slice(2, 4)}/${name}.file`
      const from = path.join(base, this.tmpKey(uploadId))
      const to = path.join(base, ...storageKey.split("/"))
      await mkdir(path.dirname(from), { recursive: true })
      await appendFile(from, Buffer.alloc(0))
      await mkdir(path.dirname(to), { recursive: true })
      await rename(from, to)
      return { storageKey, size: (await stat(to)).size }
    },

    // Читаем с диска только запрошенный диапазон. Прежде на каждый кусок
    // скачивания файл читался целиком и резался в памяти: 50 МБ кусками по
    // 512 КБ — сотня полных чтений и 50 МБ памяти на каждое.
    async *read({ storageKey, range }) {
      const start = range?.start ?? 0
      const end = range?.end
      if (end !== undefined && end <= start) return
      yield* createReadStream(path.join(base, ...String(storageKey).split("/")), {
        start,
        // У потока end включительный, у range — нет.
        ...(end !== undefined ? { end: end - 1 } : {})
      })
    },

    async remove({ storageKey }) {
      await rm(path.join(base, ...String(storageKey).split("/")), { force: true })
    },

    async abort({ uploadId }) {
      await rm(path.join(base, this.tmpKey(uploadId)), { force: true })
    }
  }
}

function normalizeOptions(input) {
  const storage = typeof input.storage === "string" ? localFileStorage(input.storage) : input.storage
  if (!storage) throw new Error("@db-state/server-files requires a storage path or FileStorage adapter")
  const servicePrefix = normalizeServicePrefix(input)

  return {
    chunkSize: DEFAULT_CHUNK_SIZE,
    defaultPolicy: { mode: "registered" },
    maxSize: DEFAULT_MAX_SIZE,
    table: input.table ?? createPrefixedTableName(servicePrefix, "file", "file"),
    ...input,
    servicePrefix,
    storage
  }
}

function assertDownloadPolicy(policy = { mode: "registered" }, client) {
  if (policy.mode === "public") return
  if (!client.user) throw new Error("Authentication required")
  if (policy.mode === "registered") return
  if (policy.mode === "groups") {
    const groups = policy.groups ?? []
    if (groups.some((group) => client.user.groups?.includes(group))) return
    throw new Error("File access denied")
  }
  if (policy.mode === "verified") {
    const kind = policy.verified ?? "any"
    const email = Boolean(client.user.emailVerified)
    const phone = Boolean(client.user.phoneVerified)
    if (kind === "email" && email) return
    if (kind === "phone" && phone) return
    if (kind === "both" && email && phone) return
    if (kind === "any" && (email || phone)) return
    throw new Error("Verification required")
  }

  throw new Error("File access denied")
}

function internalReq(client) {
  return { __dbStateFileInternal: true, user: client.user, client }
}

function sendJson(client, message) {
  client.send?.(JSON.stringify(message))
}

function toBuffer(raw) {
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  return Buffer.from(raw)
}

function createId(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex")}`
}

function createToken() {
  return randomBytes(32).toString("hex")
}

// Хэш от клиента: 64 hex-символа SHA-256, иначе его нет. Строка другой формы
// в поиск дубликатов не попадает.
function sha256Hex(value) {
  const hex = String(value ?? "").trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(hex) ? hex : undefined
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_")
}

function positiveInteger(value, fallback) {
  const normalized = Number(value ?? fallback)
  return Number.isFinite(normalized) && normalized > 0 ? Math.floor(normalized) : fallback
}
