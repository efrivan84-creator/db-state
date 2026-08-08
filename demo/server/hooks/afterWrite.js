// Файл в корне hooks/ — действует на все таблицы.
// Точка для аудита: запись уже в базе и в журнале, запретить нельзя.
export default (ctx) => {
  console.log(`[аудит] ${ctx.actorId} ${ctx.method} ${ctx.table}/${ctx.id}`)
}
