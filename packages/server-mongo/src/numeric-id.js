// Числовые _id по порядку: 1, 2, 3, ...
//
// Номера выдаёт коллекция-счётчик: один документ на таблицу,
// { _id: "zad", seq: 17 }. Номер берётся атомарным $inc, поэтому два
// одновременных запроса получат разные номера без всякой очереди —
// последовательность обеспечивает сама база.
//
// upsert создаёт документ счётчика при первом обращении, отдельного
// заведения не требуется. Гонка двух upsert-ов может дать duplicate key —
// это не ошибка, а признак того, что счётчик только что создал соседний
// запрос: повторяем, второй проход идёт обычным $inc.

const DUPLICATE_KEY = 11000
const RETRIES = 3

export const DEFAULT_COUNTER_COLLECTION = "_counter"

// Следующий номер для таблицы.
export async function nextNumericId(mongo, counterCollection, table) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const doc = await mongo.collection(counterCollection).findOneAndUpdate(
        { _id: table },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after" }
      )

      // Драйвер отдаёт документ либо напрямую, либо в поле value —
      // зависит от версии.
      const seq = doc?.seq ?? doc?.value?.seq
      if (typeof seq === "number") return seq

      throw new Error(`Счётчик ${counterCollection}/${table} не вернул seq`)
    } catch (error) {
      if (error?.code !== DUPLICATE_KEY || attempt >= RETRIES) throw error
      // Счётчик создан параллельным запросом — следующая попытка возьмёт $inc.
    }
  }
}

// Включена ли числовая нумерация для таблицы.
// true — для всех таблиц, список — только для перечисленных.
export function useNumericId(numericIds, table) {
  if (numericIds === true) return true
  if (!Array.isArray(numericIds)) return false
  return numericIds.includes(table)
}
