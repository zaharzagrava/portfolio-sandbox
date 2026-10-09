/** Typed errors of event creation and registration. Messages name types and schema paths, never payload values. */

export class InvalidEventTypeError extends Error {
  constructor(detail: string) {
    super(`Invalid event definition: ${detail}`);
    this.name = 'InvalidEventTypeError';
  }
}

export class DuplicateEventDefinitionError extends Error {
  constructor(
    readonly eventType: string,
    readonly version: number,
  ) {
    super(`Event ${eventType} v${version} is already defined`);
    this.name = 'DuplicateEventDefinitionError';
  }
}

export class InvalidAggregateVersionError extends Error {
  constructor(eventType: string) {
    super(
      `aggregateVersion of ${eventType} must be an integer between 0 and 2^53-1`,
    );
    this.name = 'InvalidAggregateVersionError';
  }
}

export class InvalidEventPayloadError extends Error {
  constructor(
    readonly eventType: string,
    /** Dotted schema paths that failed (`nested.qty`), empty path = the payload itself. */
    readonly paths: string[],
  ) {
    super(
      `Payload of ${eventType} fails its schema at: ${paths.map((p) => p || '(payload)').join(', ')}`,
    );
    this.name = 'InvalidEventPayloadError';
  }
}

/** `EventPublisher`/relay send did not complete within the publish timeout (10 s). Retryable. */
export class PublishTimeoutError extends Error {
  constructor(
    readonly topic: string,
    readonly timeoutMs: number,
  ) {
    super(`Publish to ${topic} did not finish within ${timeoutMs} ms`);
    this.name = 'PublishTimeoutError';
  }
}

/** The envelope handed to `EventPublisher` does not satisfy the contract. Names fields, never values. */
export class InvalidEnvelopeError extends Error {
  constructor(readonly paths: string[]) {
    super(`Invalid event envelope at: ${paths.join(', ')}`);
    this.name = 'InvalidEnvelopeError';
  }
}

export class EventTooLargeError extends Error {
  constructor(
    readonly eventType: string,
    readonly limitBytes: number,
    readonly actualBytes: number,
  ) {
    super(
      `Event ${eventType} is ${actualBytes} bytes, above the limit of ${limitBytes} bytes`,
    );
    this.name = 'EventTooLargeError';
  }
}
