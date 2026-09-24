// Заметки: списки и load. Синхронизацию решает readChange.js рядом — здесь
// sync пропускаем: у изменения нет фильтра, и «разрешено» ниже открыло бы
// таблицу целиком.
import { canSeeOrder, visibleOrderIds } from "./access.js"

export default async (ctx) => {
  if (ctx.method === "sync") return

  if (ctx.method === "load") {
    const note = await ctx.db.collection("order_note").findOne({ _id: ctx.id })
    if (note && !await canSeeOrder(ctx.db, ctx.user, note.orderId)) {
      return { allowed: false, reason: "Нет доступа к заказу" }
    }
    return true
  }

  // getIds / count / getUnique: только заметки своих заказов. Явное «да»:
  // права группы на order_note не спрашиваются — их и нет.
  const own = { orderId: { $in: await visibleOrderIds(ctx.db, ctx.user) } }
  ctx.filter = ctx.filter && Object.keys(ctx.filter).length ? { $and: [ctx.filter, own] } : own
  return true
}
