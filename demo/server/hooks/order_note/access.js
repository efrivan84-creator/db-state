// Кто видит заметки к заказу — одно правило на три хука: beforeRead (списки
// и load), readChange (синхронизация) и beforeWrite (добавление).
//
// Заметку видит тот, кто может править её заказ. Это правило через другую
// таблицу: у самой заметки нет поля, по которому его записать фильтром
// права группы. Поэтому оно в хуках, а в access групп order_note нет вовсе.
//
// Файл без default-экспорта и с именем не из списка хуков — загрузчик hooksDir
// его пропускает, а хуки рядом импортируют как обычный модуль.
import { accessAllows } from "@db-state/server-mongo"

export async function canSeeOrder(db, user, orderId) {
  const order = await db.collection("order").findOne({ _id: orderId })
  return Boolean(order) && accessAllows(user?.access, "order", "write", order, user)
}

// Заказы, заметки которых видны пользователю, — для сужения списков.
export async function visibleOrderIds(db, user) {
  const orders = await db.collection("order").find({}).toArray()
  return orders.filter((order) => accessAllows(user?.access, "order", "write", order, user)).map((order) => order._id)
}
