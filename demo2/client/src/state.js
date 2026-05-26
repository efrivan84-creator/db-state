import { createDbState } from "@db-state/vue"
import { createFileClient } from "@db-state/vue-files"

export const state = createDbState({
  tables: ["order", "log"],
  sessionKey: "db-state.demo2.sessionId",
  syncKey: "db-state.demo2.time1",
  userIdKey: "db-state.demo2.userId",
  authHashKey: "db-state.demo2.authHash",
  wsUrl: "ws://127.0.0.1:8788/db-state/ws"
})

export const files = createFileClient(state)
