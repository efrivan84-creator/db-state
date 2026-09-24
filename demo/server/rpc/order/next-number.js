// Именованный RPC-метод: "order.next-number" → rpc/order/next-number.js.
// Права проверяет сам — встроенные проверки на именованные методы не
// распространяются.
//
// Проверяет своё полномочие order.number, а не write: выдавать номера и
// править заказы — разные права. Менеджер получает его отдельной группой
// numbering; при входе библиотека сливает все действия групп, поэтому
// order.number доезжает до user.access вместе с read и write.
import { accessAllows } from "@db-state/server-mongo"

export default async ({ user, db }) => {
  if (!accessAllows(user?.access, "order", "number")) {
    throw new Error("Недостаточно прав для выдачи номера")
  }

  const [last] = await db.collection("order").find({}).sort({ number: -1 }).limit(1).toArray()
  return { number: (last?.number ?? 1000) + 1 }
}
