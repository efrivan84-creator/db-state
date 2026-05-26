import type { DbStateServer, DbStateServerConfig } from "@db-state/server-mongo"

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
  storageKey?: string
  status: "uploading" | "ready" | "failed"
  downloadPolicy: DownloadPolicy
  info?: Record<string, unknown>
}

export interface FileStorage {
  tmpKey(uploadId: string): string
  writeChunk(input: { uploadId: string; index: number; offset: number; chunk: Uint8Array }): Promise<void>
  finish(input: { uploadId: string }): Promise<{ storageKey: string; size: number; sha256?: string }>
  read(input: { storageKey: string; range?: { start: number; end?: number } }): AsyncIterable<Uint8Array>
  remove(input: { storageKey: string }): Promise<void>
  abort(input: { uploadId: string }): Promise<void>
}

export interface FileModuleOptions {
  table?: string
  storage: string | FileStorage
  maxSize?: number
  chunkSize?: number
  defaultPolicy?: DownloadPolicy
}

export interface FileModule {
  table: string
  tables: string[]
  access: NonNullable<DbStateServerConfig["access"]>
  hooks: NonNullable<DbStateServerConfig["hooks"]>
  bind(context: { api: DbStateServer; config: unknown; mongo: unknown; socket: DbStateServer["socket"] }): void
  handleMessage(client: unknown, message: { type?: string; [key: string]: unknown }): Promise<boolean>
  handleRawMessage(client: unknown, raw: unknown): Promise<void>
  handleClose(client: unknown): Promise<void>
}

export function createFileModule(options: FileModuleOptions): FileModule
export function localFileStorage(root: string): FileStorage
