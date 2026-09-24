// Заметки только добавляются — к заказу, который пользователь может править.
// Автора ставит сервер: от клиента берём заказ и текст, остальное не слушаем.
import { canSeeOrder } from "./access.js"

export default async (ctx) => {
  if (ctx.method !== "add") return { allowed: false, reason: "Заметки не правятся и не удаляются" }

  const text = String(ctx.obj?.text ?? "").trim()
  if (!text) return { allowed: false, reason: "Пустая заметка" }
  if (text.length > 500) return { allowed: false, reason: "Заметка длиннее 500 символов" }
  if (!await canSeeOrder(ctx.db, ctx.user, ctx.obj?.orderId)) return { allowed: false, reason: "Нет доступа к заказу" }

  // info (кто и когда создал) ставит библиотека — сохраняем его.
  ctx.obj = { _id: ctx.id, orderId: ctx.obj.orderId, text, authorId: ctx.user._id, info: ctx.obj.info }
  return true
}
