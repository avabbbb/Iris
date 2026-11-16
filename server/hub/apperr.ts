/**
 * Port of backend/apperr: business errors that may be shown to the client.
 * Anything that is not an AppError is treated as internal: logged, and the
 * client only sees the generic 500 message (no SQL / storage details).
 */
export class AppError extends Error {
  readonly status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.name = 'AppError';
    this.status = status;
  }
}

export const appErr = {
  new: (status: number, msg: string) => new AppError(status, msg),
  badRequest: (msg: string) => new AppError(400, msg),
  unauthorized: (msg: string) => new AppError(401, msg),
  forbidden: (msg: string) => new AppError(403, msg),
  notFound: (msg: string) => new AppError(404, msg),
  conflict: (msg: string) => new AppError(409, msg),
};

/** Returns the AppError, or null when err is not a business error (Go: apperr.As). */
export function asAppError(err: unknown): AppError | null {
  return err instanceof AppError ? err : null;
}
