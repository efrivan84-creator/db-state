import type { DbState, TableApi } from "@db-state/vue"

export type DownloadPolicy =
  | { mode: "public" }
  | { mode: "registered" }
  | { mode: "verified"; verified?: "email" | "phone" | "any" | "both" }
  | { mode: "groups"; groups: string[] }

export interface FileRecord {
  _id: string
  ownerId: string
  token?: string
  name: string
  mime: string
  size: number
  status: "uploading" | "ready" | "failed"
  downloadPolicy: DownloadPolicy
  info?: Record<string, unknown>
}

export interface FileProgress {
  loaded: number
  total: number
  percent: number
}

export interface UploadOptions {
  name?: string
  mime?: string
  policy?: DownloadPolicy
  onProgress?: (progress: FileProgress) => void
  /**
   * Send the file's SHA-256 so the server can link an identical stored file
   * instead of receiving the bytes again. Default `true`; skipped for files
   * larger than `hashMaxSize` or without `crypto.subtle`.
   */
  hash?: boolean
}

export interface DownloadOptions {
  chunkSize?: number
  onProgress?: (progress: FileProgress) => void
}

export interface UploadResult {
  id: string
  token: string
  file: FileRecord
  /** `true` when the server already had identical bytes and no data was sent. */
  deduplicated: boolean
}

export interface FileClient {
  upload(file: Blob & { name?: string }, options?: UploadOptions): Promise<UploadResult>
  download(token: string, options?: DownloadOptions): Promise<Blob>
  url(token: string): string
}

export function createFileClient<TState extends DbState>(
  state: TState & { file?: TableApi<FileRecord> },
  options?: {
    table?: string
    servicePrefix?: string
    prefix?: string
    urlPrefix?: string
    /** Largest file hashed for deduplication, bytes. Default 256 MB. */
    hashMaxSize?: number
  }
): FileClient
