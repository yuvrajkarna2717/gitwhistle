/** Consistent success envelope: { data, meta? } */
export function ok(res, data, meta, status = 200) {
  const body = { data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

export function created(res, data) {
  return ok(res, data, undefined, 201);
}

export function noContent(res) {
  return res.status(204).end();
}

/** Apply offset pagination to a knex query and return { rows, meta }. */
export async function paginate(query, { page, pageSize }) {
  const countQuery = query.clone().clearSelect().clearOrder().count({ count: '*' }).first();
  const [countRow, rows] = await Promise.all([countQuery, query.limit(pageSize).offset((page - 1) * pageSize)]);
  const total = Number(countRow?.count || 0);
  return { rows, meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
}
