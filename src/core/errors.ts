/**
 * Every failure that reaches the user is an FornaxError: a stable machine-readable code,
 * a human message, a hint and — where it helps — the command that makes sense next.
 * Agents branch on `code` and follow `next`; humans read `message` and `hint`.
 */
export class FornaxError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly next?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.next ? { next: this.next } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/** Anything thrown, as the error the user sees: an unexpected one is a bug in fornax. */
export const asFornaxError = (e: unknown): FornaxError =>
  e instanceof FornaxError ? e : new FornaxError("internal_error", (e as Error)?.message ?? String(e), "this is a bug in fornax", undefined, { stack: (e as Error)?.stack });

export const fail =(code: string, message: string, hint?: string, next?: string, details?: unknown): never => {
  throw new FornaxError(code, message, hint, next, details);
};
