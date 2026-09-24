import { createDbState, createMemoryCache } from "@db-state/vue"

export const state = createDbState({
  // order_note — заметки к заказам: видит их тот, кто может править заказ
  // (хуки demo/server/hooks/order_note/).
  tables: ["order", "order_note"],
  cache: createMemoryCache(),
  wsUrl: "ws://127.0.0.1:8787/db-state/ws"
})
