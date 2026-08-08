// Именованный RPC-метод: "order.next-number" → rpc/order/next-number.js.
// Права проверяет сам — встроенные проверки на именованные методы не
// распространяются.
import { accessAllows } from "@db-state/server-mongo"

export default async ({ user, db }) => {
  if (!accessAllows(user?.access, "order", "write")) {
    throw new Error("Недостаточно прав для выдачи номера")
  }

  const [last] = await db.collection("order").find({}).sort({ number: -1 }).limit(1).toArray()
  return { number: (last?.number ?? 1000) + 1 }
}
