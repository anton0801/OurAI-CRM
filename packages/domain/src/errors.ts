/**
 * Domain and application errors. Every error that crosses the API boundary has a stable
 * machine-readable code; the HTTP status is derived from the code, never chosen ad hoc.
 */
export type ErrorCode =
  | 'MALFORMED_REQUEST'
  | 'UNAUTHENTICATED'
  | 'MFA_REQUIRED'
  | 'RECENT_AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE'
  | 'INVALID_STATE'
  | 'VERSION_CONFLICT'
  | 'PRECONDITION_REQUIRED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_PAYLOAD_MISMATCH'
  | 'OPERATION_IN_PROGRESS'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'CSRF_REJECTED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'CONFIGURATION_MISSING'
  | 'PAYLOAD_TOO_LARGE'
  | 'QUOTA_EXCEEDED'
  | 'INTERNAL';

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  MALFORMED_REQUEST: 400,
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  RECENT_AUTH_REQUIRED: 403,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE: 409,
  INVALID_STATE: 409,
  IDEMPOTENCY_PAYLOAD_MISMATCH: 409,
  OPERATION_IN_PROGRESS: 409,
  VERSION_CONFLICT: 412,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_FAILED: 422,
  QUOTA_EXCEEDED: 422,
  PRECONDITION_REQUIRED: 428,
  IDEMPOTENCY_KEY_REQUIRED: 428,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  CONFIGURATION_MISSING: 503,
  DEPENDENCY_UNAVAILABLE: 503,
};

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface AppErrorOptions {
  fieldErrors?: FieldError[];
  retryable?: boolean;
  retryAfterSeconds?: number;
  currentVersion?: number;
  /** Safe, permission-filtered details that may be returned to the caller. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly fieldErrors: FieldError[];
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly currentVersion?: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.fieldErrors = options.fieldErrors ?? [];
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.currentVersion = options.currentVersion;
    this.details = options.details;
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

// Convenience constructors keep call sites short and consistent.
export const notFound = (what = 'Record') => new AppError('NOT_FOUND', `${what} was not found.`);
export const forbidden = (message = 'You do not have permission to perform this action.') =>
  new AppError('FORBIDDEN', message);
export const invalidState = (message: string, details?: Record<string, unknown>) =>
  new AppError('INVALID_STATE', message, { details });
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError('CONFLICT', message, { details });
export const duplicate = (message: string, details?: Record<string, unknown>) =>
  new AppError('DUPLICATE', message, { details });
export const versionConflict = (currentVersion?: number) =>
  new AppError('VERSION_CONFLICT', 'This record changed while you were editing it.', { currentVersion });
export const validation = (fieldErrors: FieldError[], message = 'Some fields need attention.') =>
  new AppError('VALIDATION_FAILED', message, { fieldErrors });
export const fieldError = (field: string, code: string, message: string) =>
  validation([{ field, code, message }], message);
