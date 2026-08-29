/** Converts an Error and its immediate cause into enumerable log data. */
export function toLoggableError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const properties = Object.fromEntries(Object.entries(error));
  return {
    ...properties,
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined
      ? {}
      : {
          cause:
            error.cause instanceof Error
              ? {
                  ...Object.fromEntries(Object.entries(error.cause)),
                  name: error.cause.name,
                  message: error.cause.message,
                  stack: error.cause.stack,
                }
              : error.cause,
        }),
  };
}
