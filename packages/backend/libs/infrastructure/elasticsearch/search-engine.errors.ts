/** The engine could not answer in time or at all (timeout, refused connection, 5xx, 429): retry later. */
export class EngineUnavailableError extends Error {
  readonly retryable = true;
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

/** The engine understood the call and refused it (4xx other than 429): retrying the same call cannot help. */
export class EngineRejectedError extends Error {
  readonly retryable = false;
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly type: string | undefined,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EngineRejectedError';
  }
}

export type EngineError = EngineUnavailableError | EngineRejectedError;

/** Maps what the client library throws onto the two typed errors; never leaks the engine's message to callers' users. */
export function classifyEngineError(error: unknown): EngineError {
  if (
    error instanceof EngineUnavailableError ||
    error instanceof EngineRejectedError
  )
    return error;
  const e = error as {
    name?: string;
    code?: string;
    message?: string;
    meta?: { statusCode?: number; body?: { error?: { type?: string } } };
  };
  const status = e?.meta?.statusCode;
  const type = e?.meta?.body?.error?.type;
  if (status === undefined || status === 0) {
    // TimeoutError, ConnectionError, NoLivingConnectionsError, RequestAbortedError, ECONNREFUSED ...
    return new EngineUnavailableError(
      `search engine unreachable (${e?.name ?? e?.code ?? 'error'})`,
      error,
    );
  }
  if (status === 429 || status >= 500)
    return new EngineUnavailableError(
      `search engine unavailable (${status}${type ? `, ${type}` : ''})`,
      error,
    );
  return new EngineRejectedError(
    `search engine rejected the request (${status}${type ? `, ${type}` : ''})`,
    status,
    type,
    error,
  );
}
