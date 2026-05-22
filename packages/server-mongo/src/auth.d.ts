import type { SocketClient } from "./socket"

/** Pluggable password hashing primitive used by the auth layer. */
export interface PasswordHasher {
  hash(plain: string): Promise<string> | string
  verify(plain: string, stored: string): Promise<boolean> | boolean
}

/** Default PBKDF2-SHA256 hasher used when no override is provided. */
export const defaultPassword: PasswordHasher

/** Default auth-hash generator (32 random bytes hex-encoded). */
export function defaultAuthHash(): string

/** Stable SHA-256 hash of a value (hex). Exposed for callers building custom hashes. */
export function hashValue(value: unknown): string

/** Incoming message shape recognised by `dbstate:login`. */
export interface LoginMessage {
  id?: string
  login: string
  password: string
}

/** Incoming message shape recognised by `dbstate:auth`. */
export interface AuthMessage {
  id?: string
  userId: string
  hash: string
}

/** Incoming message shape recognised by `dbstate:logout`. */
export interface LogoutMessage {
  id?: string
}

/** Auth namespace exposed to the socket dispatcher. */
export interface AuthHandlers {
  login(client: SocketClient, message: LoginMessage): Promise<void>
  auth(client: SocketClient, message: AuthMessage): Promise<void>
  logout(client: SocketClient, message: LogoutMessage): void
}

export function createAuth(config: {
  mongo: { collection(name: string): unknown }
  userTable: string
  password: PasswordHasher
  createAuthHash: () => string
}): AuthHandlers
