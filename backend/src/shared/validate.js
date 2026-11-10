import { z } from 'zod';
import { validationError } from './errors.js';

function formatIssues(error) {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/**
 * Validate and coerce request parts. Parsed values replace the originals on
 * req.validated so handlers never touch unvalidated input.
 */
export function validate({ params, query, body } = {}) {
  return (req, _res, next) => {
    const out = {};
    for (const [key, schema] of Object.entries({ params, query, body })) {
      if (!schema) continue;
      const result = schema.safeParse(req[key] ?? {});
      if (!result.success) return next(validationError(formatIssues(result.error)));
      out[key] = result.data;
    }
    req.validated = { ...(req.validated || {}), ...out };
    next();
  };
}

export function parseOrThrow(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(formatIssues(result.error));
  return result.data;
}

export const uuid = z.uuid();
export const idParam = (name = 'id') => z.object({ [name]: z.uuid() }).loose();

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
