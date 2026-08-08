export default (ctx) => {
  console.warn(`[отказ] ${ctx.method} ${ctx.table}: ${ctx.error.message}`)
}
