// Typed application errors. Services and routes throw these; the global error
// handler (`src/lib/error-handler.ts`) is the only place that turns one into an
// HTTP status code and an envelope body.
//
// The 400-vs-422 split is the rule from docs/handoff/phase-2.md § 8 D1:
//   malformed                -> 400 BAD_REQUEST
//   well-formed but invalid  -> 422 VALIDATION_ERROR

/** One per-field failure, as it appears in `error.details[]`. */
export interface ErrorDetail {
  /** snake_case wire name, not the Prisma name. */
  field: string;
  message: string;
}

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;

  /**
   * Non-null only for VALIDATION_ERROR — see handoff § 2. Every other error
   * carries `null` so clients can rely on the shape.
   */
  readonly details: ErrorDetail[] | null;

  constructor(message: string, details: ErrorDetail[] | null = null) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

/** Request is malformed before field validation can run. */
export class BadRequestError extends AppError {
  readonly statusCode = 400;
  readonly code = 'BAD_REQUEST';
}

/** No live patient with that id (soft-deleted rows are indistinguishable). */
export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
}

/** Parsed fine, violates a field rule. Always carries `details`. */
export class ValidationError extends AppError {
  readonly statusCode = 422;
  readonly code = 'VALIDATION_ERROR';

  constructor(message: string, details: ErrorDetail[]) {
    super(message, details);
  }
}
