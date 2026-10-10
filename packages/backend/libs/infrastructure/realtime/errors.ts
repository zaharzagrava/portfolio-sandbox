/** Typed errors of the realtime lib (S51 FR-021, FR-042). Validation errors reject before the store is touched. */
export class InvalidRealtimeTopicError extends Error {
  constructor(topic: string) {
    super(`invalid realtime topic: ${JSON.stringify(topic).slice(0, 120)}`);
    this.name = 'InvalidRealtimeTopicError';
  }
}

export class InvalidRealtimeEventTypeError extends Error {
  constructor(type: string) {
    super(`invalid realtime event type: ${JSON.stringify(type).slice(0, 80)}`);
    this.name = 'InvalidRealtimeEventTypeError';
  }
}

export class RealtimePayloadTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`realtime payload is ${bytes} bytes, the limit is ${limit}`);
    this.name = 'RealtimePayloadTooLargeError';
  }
}

export class InvalidRealtimePayloadError extends Error {
  constructor(reason: string) {
    super(`realtime payload cannot be serialized: ${reason}`);
    this.name = 'InvalidRealtimePayloadError';
  }
}

export class RealtimeUnavailableError extends Error {
  constructor(reason: string) {
    super(`realtime backplane unavailable: ${reason}`);
    this.name = 'RealtimeUnavailableError';
  }
}
