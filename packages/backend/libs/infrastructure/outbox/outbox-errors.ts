/** `append`/`appendTask` need the caller's transaction so the event commits or rolls back with the state change. */
export class NoActiveTransactionError extends Error {
  constructor(readonly types: string[]) {
    super(
      `Appending ${types.join(', ')} needs an active transaction (TransactionRunner.run / @Transactional); use appendStandalone for an event with no state change of its own`,
    );
    this.name = 'NoActiveTransactionError';
  }
}

export class InvalidTaskError extends Error {
  constructor(detail: string) {
    super(`Invalid outbox task: ${detail}`);
    this.name = 'InvalidTaskError';
  }
}
