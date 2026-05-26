import { randomBytes } from "node:crypto"
import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises"
import path from "node:path"

const DEFAULT_CHUNK_SIZE = 512 * 1024
const DEFAULT_MAX_SIZE = 50 * 1024 * 1024
const FILE_FIELDS = ["ownerId", "token", "name", "mime", "size", "status", "downloadPolicy", "info"]

export function createFileModule(input = {}) {
  const options = normalizeOptions(input)
  const uploads = new Map()
  const downloads = new Map()
  let api
  let config

  const module = {
    table: options.table,
    tables: [options.table],
    access: {
      [options.table]: {
        read: ({ req, user, obj }) => {
          if (req?.__dbStateFileInternal) return true
          if (!user || !obj || obj.ownerId !== user._id) return false
          return { allowed: true, fields: FILE_FIELDS }
        },
        write: ({ req }) => req?.__dbStateFileInternal === true
      }
    },
    hooks: {},

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

    const upload = { id: message.id, uploadId, fileId, offset: 0, size }
    uploads.set(client, upload)
    if (size === 0) {
      await finishUpload(client, upload)
      return
    }
    sendUploadNext(client, upload)
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
    upload.offset += chunk.length

    if (upload.offset < upload.size) {
      sendUploadNext(client, upload)
      return
    }

    await finishUpload(client, upload)
  }

  async function finishUpload(client, upload) {
    const result = await options.storage.finish({ uploadId: upload.uploadId })
    const token = createToken()
    await api.update({
      table: options.table,
      id: upload.fileId,
      set: {
        status: "ready",
        storageKey: result.storageKey,
        size: result.size,
        token
      },
      req: internalReq(client),
      sessionId: client.sessionId
    })

    uploads.delete(client)
    const file = await api.load({ table: options.table, id: upload.fileId, req: { client } })
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

    async *read({ storageKey, range }) {
      const file = await readFile(path.join(base, ...String(storageKey).split("/")))
      yield file.subarray(range?.start ?? 0, range?.end ?? file.length)
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

  return {
    chunkSize: DEFAULT_CHUNK_SIZE,
    defaultPolicy: { mode: "registered" },
    maxSize: DEFAULT_MAX_SIZE,
    table: "file",
    ...input,
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

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_")
}

function positiveInteger(value, fallback) {
  const normalized = Number(value ?? fallback)
  return Number.isFinite(normalized) && normalized > 0 ? Math.floor(normalized) : fallback
}
