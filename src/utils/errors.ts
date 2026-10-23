/**
 * Application error model shared by the HTTP API and the MCP server.
 * Messages are written for the calling agent: concise, actionable, and free of
 * internal details (stack traces, internal IPs, upstream headers, secrets).
 */
export const ERROR_STATUS = {
  invalid_request: 400,
  invalid_url: 400,
  blocked_destination: 400,
  request_too_large: 413,
  unsupported_media_type: 415,
  host_not_found: 422,
  dns_resolution_failed: 502,
  upstream_http_error: 502,
  upstream_unreachable: 502,
  upstream_timeout: 504,
  too_many_redirects: 422,
  unsupported_content_type: 422,
  content_too_large: 422,
  empty_content: 422,
  javascript_required: 422,
  payment_invalid: 402,
  rate_limited: 429,
  not_found: 404,
  method_not_allowed: 405,
  payments_unavailable: 503,
  internal_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

/** Normalise anything thrown into an AppError without leaking internals. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError("internal_error", "An internal error occurred while processing the request.");
}

export function errorBody(err: AppError): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}
