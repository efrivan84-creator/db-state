// Заметки: синхронизация. Вызывается на каждое изменение order_note, которое
// sync собирается отдать. Правило то же, что у списков (access.js), — иначе
// заметка к чужому заказу, скрытая в списке, пришла бы изменением.
//
// fullaccess этот хук не обходит: решение здесь принимается и для него.
import { canSeeOrder } from "./access.js"

export default async (ctx) => {
  // loadDoc — текущая заметка; для удаления — заметка до удаления.
  const note = await ctx.loadDoc()
  return Boolean(note) && await canSeeOrder(ctx.db, ctx.user, note.orderId)
}
