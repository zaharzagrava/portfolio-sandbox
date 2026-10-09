/** Typed errors of the topic registry (S53 FR-004, FR-005). */

export class UnregisteredAggregateTypeError extends Error {
  constructor(readonly aggregateType: string) {
    super(
      `Aggregate type "${aggregateType}" is not registered with the topic registry`,
    );
    this.name = 'UnregisteredAggregateTypeError';
  }
}

export class DuplicateAggregateTypeError extends Error {
  constructor(readonly aggregateType: string) {
    super(`Aggregate type "${aggregateType}" is already registered`);
    this.name = 'DuplicateAggregateTypeError';
  }
}

export class InvalidAggregateTypeError extends Error {
  constructor(readonly aggregateType: string) {
    super(
      `Aggregate type "${aggregateType}" must be lowercase letters, digits and underscores, starting with a letter`,
    );
    this.name = 'InvalidAggregateTypeError';
  }
}

export class InvalidPartitionCountError extends Error {
  constructor(aggregateType: string) {
    super(`Partition count of "${aggregateType}" must be a positive integer`);
    this.name = 'InvalidPartitionCountError';
  }
}

/** A `latest-per-key` topic holds an event that does not carry the full aggregate state. */
export class TopicPolicyError extends Error {
  constructor(
    readonly aggregateType: string,
    readonly eventTypes: string[],
  ) {
    super(
      `Topic ${aggregateType}.events is latest-per-key but these events do not carry state: ${eventTypes.join(', ')}`,
    );
    this.name = 'TopicPolicyError';
  }
}
