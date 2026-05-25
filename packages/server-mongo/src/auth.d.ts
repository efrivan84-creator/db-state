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
  /** Login identifier value. The server matches it against `authLoginFields`. */
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

export interface AuthRateLimitContext {
  type: "login" | "auth"
  login?: string
  userId?: string
  client: SocketClient
}

export interface AuthWarning {
  type: "ambiguous_auth_login"
  login: string
  normalized: Record<string, string>
  fields: ReadonlyArray<string>
  count: number
  client: SocketClient
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
  authLoginFields: ReadonlyArray<string>
  normalizeAuthLogin: (value: unknown, field: string) => string
  authRateLimit?: (ctx: AuthRateLimitContext) => Promise<boolean | void> | boolean | void
  onAuthWarning?: (warning: AuthWarning) => void
  password: PasswordHasher
  createAuthHash: () => string
}): AuthHandlers
