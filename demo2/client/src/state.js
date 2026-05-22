import { createDbState } from "../../../packages/vue/src/index.js"

export const state = createDbState({
  tables: ["order"],
  sessionKey: "db-state.demo2.sessionId",
  syncKey: "db-state.demo2.time1",
  userIdKey: "db-state.demo2.userId",
  authHashKey: "db-state.demo2.authHash",
  wsUrl: "ws://127.0.0.1:8788/db-state/ws"
})
