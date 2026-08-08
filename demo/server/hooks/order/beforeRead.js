// Хук таблицы order: файл лежит в hooks/order/, поэтому ctx.table проверять
// не нужно — он вызывается только для этой таблицы.
//
// Права целиком в access групп (см. _group в index.js). Хук — для того, что
// фильтром не выразить.
export default (ctx) => {
  // Потолок выборки для всех, включая руководителя.
  if (ctx.method === "getIds") ctx.limit = Math.min(ctx.limit || 50, 50)

  // Динамическое сужение полей: ctx.fields уходит в projection запроса.
  // Сузить можно, расширить сверх read_fields группы — нет.
  if (ctx.method === "load" && !ctx.user.groups.includes("admin")) {
    ctx.fields = ["number", "status", "client", "total", "comment", "ownerId"]
  }

  // Ничего не вернули → дальше решает access группы.
}
