const DEFAULT_CHUNK_SIZE = 512 * 1024

export function createFileClient(state, options = {}) {
  const table = options.table ?? "file"
  const uploads = new Map()
  const downloads = new Map()
  const loadingByKey = new Map()
  let activeDownload

  state.registerTable?.(table)

  state.socket.on("dbfile:upload_next", (message) => {
    const upload = uploads.get(message.id)
    if (upload) sendUploadChunk(upload, message)
  })

  state.socket.on("dbfile:upload_done", async (message) => {
    const upload = uploads.get(message.id)
    if (!upload) return
    uploads.delete(message.id)
    upload.finishKey()
    if (message.file) {
      await state.applyChange({ table, id: message.fileId, action: "insert", obj: message.file })
    }
    upload.resolve({ id: message.fileId, token: message.token, file: message.file })
  })

  state.socket.on("dbfile:download_info", (message) => {
    const download = downloads.get(message.id)
    if (!download) return
    download.total = Number(message.size ?? 0)
    download.name = message.name
    download.mime = message.mime
    download.onProgress?.(progress(download))
  })

  state.socket.on("dbfile:download_done", (message) => {
    const download = downloads.get(message.id)
    if (!download) return
    downloads.delete(message.id)
    if (activeDownload?.id === message.id) activeDownload = undefined
    download.finishKey()
    const blob = new Blob(download.chunks, { type: message.mime || download.mime || "application/octet-stream" })
    download.resolve(blob)
  })

  state.socket.on("dbfile:error", (message) => {
    const item = uploads.get(message.id) ?? downloads.get(message.id)
    if (!item) return
    uploads.delete(message.id)
    downloads.delete(message.id)
    item.finishKey()
    item.reject(new Error(message.error || "db-state file error"))
  })

  state.socket.onRaw((raw) => {
    if (!activeDownload) return
    activeDownload.chunks.push(raw)
    activeDownload.loaded += rawSize(raw)
    activeDownload.onProgress?.(progress(activeDownload))
    sendJson(state, { type: "dbfile:download_next", id: activeDownload.id, offset: activeDownload.loaded })
  })

  return {
    upload(file, uploadOptions = {}) {
      const id = createId()
      const size = Number(file.size ?? 0)
      const upload = {
        id,
        file,
        loaded: 0,
        total: size,
        onProgress: uploadOptions.onProgress,
        finishKey: startKey(state, uploadOptions.key, loadingByKey)
      }

      uploads.set(id, {
        ...upload,
        resolve: undefined,
        reject: undefined
      })

      const promise = new Promise((resolve, reject) => {
        Object.assign(uploads.get(id), { resolve, reject })
      })

      uploadOptions.onProgress?.(progress(upload))
      sendJson(state, {
        type: "dbfile:upload_start",
        id,
        name: uploadOptions.name || file.name || "file",
        mime: uploadOptions.mime || file.type || "application/octet-stream",
        size,
        policy: uploadOptions.policy
      }).catch((error) => {
        const current = uploads.get(id)
        uploads.delete(id)
        upload.finishKey()
        current?.reject?.(error)
      })

      return promise
    },

    download(token, downloadOptions = {}) {
      const id = createId()
      const download = {
        id,
        token,
        chunks: [],
        loaded: 0,
        total: 0,
        onProgress: downloadOptions.onProgress,
        finishKey: startKey(state, downloadOptions.key, loadingByKey),
        resolve: undefined,
        reject: undefined
      }

      downloads.set(id, download)
      activeDownload = download

      const promise = new Promise((resolve, reject) => {
        Object.assign(download, { resolve, reject })
      })

      sendJson(state, {
        type: "dbfile:download_start",
        id,
        token,
        chunkSize: downloadOptions.chunkSize ?? DEFAULT_CHUNK_SIZE
      }).catch((error) => {
        downloads.delete(id)
        download.finishKey()
        reject(error)
      })

      return promise
    },

    url(token) {
      return `${options.urlPrefix ?? "/f"}/${encodeURIComponent(token)}`
    }
  }

  async function sendUploadChunk(upload, message) {
    const offset = Number(message.offset ?? upload.loaded)
    const chunkSize = Number(message.chunkSize ?? DEFAULT_CHUNK_SIZE)
    const end = Math.min(upload.total, offset + chunkSize)
    const chunk = upload.file.slice(offset, end)
    await state.socket.sendRaw(await chunk.arrayBuffer())
    upload.loaded = end
    upload.onProgress?.(progress(upload))
  }
}

function sendJson(state, message) {
  return state.socket.sendRaw(JSON.stringify(message))
}

function startKey(state, key, loadingByKey) {
  if (!key) return () => {}
  const token = createId()
  if (!loadingByKey.has(key)) loadingByKey.set(key, new Set())
  const tokens = loadingByKey.get(key)
  tokens.add(token)
  const loading = state.getKeyRef(key)
  loading.value = tokens.size
  loading.max = Math.max(loading.max, tokens.size)
  loading.start = true
  return () => {
    tokens.delete(token)
    loading.value = tokens.size
    if (tokens.size === 0) {
      loading.max = 0
      loadingByKey.delete(key)
    }
  }
}

function progress(item) {
  return {
    loaded: item.loaded,
    total: item.total,
    percent: item.total > 0 ? (item.loaded / item.total) * 100 : 0
  }
}

function rawSize(raw) {
  if (raw instanceof ArrayBuffer) return raw.byteLength
  if (ArrayBuffer.isView(raw)) return raw.byteLength
  return raw.size ?? raw.length ?? 0
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`
}
