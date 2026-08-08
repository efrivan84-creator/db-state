export default (ctx) => {
  // Архивный заказ не правит никто, даже руководитель: запрет из хука
  // сильнее прав группы.
  if (ctx.old?.status === "в архиве") {
    return { allowed: false, reason: "Архивный заказ изменять нельзя" }
  }

  // Нормализуем статус до записи.
  if (ctx.method === "update" && typeof ctx.set.status === "string") {
    ctx.set.status = ctx.set.status.trim().toLowerCase()
  }
}
