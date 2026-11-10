import { AppError } from '../shared/errors.js';
import { errSummary } from '../shared/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    if (err.status >= 500) req.log?.error({ err: errSummary(err) }, err.message);
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // body-parser errors (oversized / malformed JSON)
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body' } });
  }
  req.log?.error({ err: errSummary(err) }, 'Unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'An unexpected error occurred' } });
}
