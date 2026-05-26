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
  key?: string
  name?: string
  mime?: string
  policy?: DownloadPolicy
  onProgress?: (progress: FileProgress) => void
}

export interface DownloadOptions {
  key?: string
  chunkSize?: number
  onProgress?: (progress: FileProgress) => void
}

export interface UploadResult {
  id: string
  token: string
  file: FileRecord
}

export interface FileClient {
  upload(file: Blob & { name?: string }, options?: UploadOptions): Promise<UploadResult>
  download(token: string, options?: DownloadOptions): Promise<Blob>
  url(token: string): string
}

export function createFileClient<TState extends DbState>(
  state: TState & { file?: TableApi<FileRecord> },
  options?: { table?: string; urlPrefix?: string }
): FileClient
