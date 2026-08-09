/** Converts an Error and its immediate cause into enumerable log data. */
export function toLoggableError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  return {
    ...error,
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined
      ? {}
      : {
          cause:
            error.cause instanceof Error
              ? {
                  ...error.cause,
                  name: error.cause.name,
                  message: error.cause.message,
                  stack: error.cause.stack,
                }
              : error.cause,
        }),
  };
}
