/**
 * Errors a handler or sink throws to tell the consumer framework what to do (S53 contracts/dead-letter.md):
 *  - `TransientError`: the store or network is unwell: pause the partition, back off, never dead-letter.
 *  - `PermanentError`: this event cannot be applied: attempt budget, then the dead-letter topic.
 *  - anything else is unclassified and treated as permanent.
 */
export class TransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientError';
  }
}

export class PermanentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

/** Thrown by sinks when the downstream store is saturated: the partition pauses for `retryAfterMs`, not a failure. */
export class SinkBackpressureError extends TransientError {
  constructor(
    message: string,
    readonly retryAfterMs = 1_000,
  ) {
    super(message);
    this.name = 'SinkBackpressureError';
  }
}

/** A handler did not finish within the handler timeout (30 s): transient, counted in the attempt budget. */
export class HandlerTimeoutError extends TransientError {
  constructor(readonly timeoutMs: number) {
    super(`handler did not finish within ${timeoutMs} ms`);
    this.name = 'HandlerTimeoutError';
  }
}

/** A consumer is registered wrongly: startup fails, naming it and every problem found. */
export class ConsumerDeclarationError extends Error {
  constructor(
    readonly consumer: string,
    readonly problems: string[],
  ) {
    super(`Consumer "${consumer}" is declared wrongly: ${problems.join('; ')}`);
    this.name = 'ConsumerDeclarationError';
  }
}
