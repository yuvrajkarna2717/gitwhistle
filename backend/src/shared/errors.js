export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

export const badRequest = (message = 'Bad request', details) => new AppError(400, 'bad_request', message, details);
export const validationError = (details) => new AppError(422, 'validation_failed', 'Request validation failed', details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message = 'Conflict', details) => new AppError(409, 'conflict', message, details);
export const serviceUnavailable = (message = 'Service unavailable') => new AppError(503, 'unavailable', message);
