import { EventEnvelope } from './event-envelope';

/**
 * The wire form of an event on the log (S53 FR-013): keyed by `aggregateId`, the value is the envelope itself (no
 * wrapper), headers carry `eventId`, `type`, `version` and, when there is one, `traceparent`. The poller, the plain
 * publisher and the CDC connector produce this same message.
 */
export function envelopeMessage(envelope: EventEnvelope) {
  return {
    key: envelope.aggregateId,
    value: JSON.stringify(envelope),
    headers: {
      eventId: envelope.eventId,
      type: envelope.type,
      version: String(envelope.version),
      ...(envelope.traceparent && { traceparent: envelope.traceparent }),
    },
  };
}
