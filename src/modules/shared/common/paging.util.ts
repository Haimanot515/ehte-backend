export function paging(q: { page?: number; limit?: number }) {
  const page = q.page && q.page > 0 ? q.page : 1;
  const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 100) : 20;
  return { page, limit, skip: (page - 1) * limit };
}

export function pageMeta(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

export function dateRange(q: { from?: string; to?: string }, defaultDays: number) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - defaultDays * 86_400_000);
  return { from, to };
}
