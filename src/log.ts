/**
 * Converts an Error and its cause chain into enumerable log data.
 *
 * Cause chains are assumed to be acyclic; a cycle would recurse until the stack overflows.
 */
export function toLoggableError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  return {
    ...Object.fromEntries(Object.entries(error)),
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined ? {} : { cause: toLoggableError(error.cause) }),
  };
}
