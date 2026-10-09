import { Injectable } from '@nestjs/common';
import { KafkaContext } from '@nestjs/microservices';
import {
  Context,
  propagation,
  trace,
  ROOT_CONTEXT,
  Span,
  SpanStatusCode,
  TraceFlags,
} from '@opentelemetry/api';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { KafkaTopicGroup } from '@app/infrastructure/outbox/outbox.model';
import { KafkaMessage } from 'kafkajs';

export interface ConsumeKafkaEventOptions<T, P> {
  spanName: string;
  data: P;
  context: KafkaContext;
  responseTopic: KafkaTopicGroup;
  dlqTopic: KafkaTopicGroup;
  handler: (params: {
    data: P;
    activeSpan: Span;
    idempotencyKey: string;
    context: KafkaContext;
    responseTopic: KafkaTopicGroup;
  }) => Promise<T>;
}

@Injectable()
export class KafkaConsumerService {
  private readonly tracer = trace.getTracer('kafka-consumer-service');

  constructor(private readonly outboxService: OutboxService) {}

  async consume<T, P>(
    options: ConsumeKafkaEventOptions<T, P>,
  ): Promise<T | void> {
    const { spanName, data, context, responseTopic, dlqTopic, handler } =
      options;

    const originalMessage = context.getMessage();
    const idempotencyKey = originalMessage.key?.toString() ?? '';
    const parentContext = this.extractParentContext(originalMessage);

    return await this.tracer.startActiveSpan(
      spanName,
      {
        attributes: {
          'messaging.system': 'kafka',
          'messaging.destination': context.getTopic(),
          'messaging.operation': 'process',
        },
      },
      parentContext,
      async (span) => {
        try {
          span.addEvent('Trace started successfully');
          if (idempotencyKey) {
            span.setAttribute(
              'messaging.kafka.idempotency_key',
              idempotencyKey,
            );
          }
          span.setAttribute('messaging.kafka.topic', context.getTopic());

          // Delegate to your centralized Outbox & Error Boundary
          return await this.outboxService.wrapInOutbox(
            async () => {
              return await handler({
                data,
                activeSpan: span,
                idempotencyKey,
                context,
                responseTopic,
              });
            },
            {
              payload: data,
              dlqTopic,
            },
          );
        } catch (error: any) {
          // Any error reaching here was evaluated as isRetryable === true by wrapInOutbox
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
          span.addEvent(
            'Transient infrastructure failure; re-throwing to trigger KafkaJS backoff.',
          );

          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /** Convert KafkaJS record headers into a string carrier for W3C propagation.extract. */
  private kafkaHeadersToCarrier(
    headers: KafkaMessage['headers'] | undefined,
  ): Record<string, string> {
    const carrier: Record<string, string> = {};
    if (!headers) return carrier;

    for (const [key, value] of Object.entries(headers)) {
      if (value == null) continue;
      const raw = Array.isArray(value) ? value[0] : value;
      if (raw == null) continue;
      carrier[key.toLowerCase()] = Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : String(raw);
    }

    return carrier;
  }

  private extractParentContext(message: KafkaMessage): Context {
    const carrier = this.kafkaHeadersToCarrier(message.headers);

    // Prefer the global propagator (NodeSDK registers W3CTraceContextPropagator)
    const extracted = propagation.extract(ROOT_CONTEXT, carrier);
    const extractedCtx = trace.getSpanContext(extracted);
    if (extractedCtx?.isRemote && trace.isSpanContextValid(extractedCtx)) {
      return extracted;
    }

    // Fallback: parse W3C traceparent directly if propagator was still a no-op
    const traceparent = carrier.traceparent;
    if (!traceparent) return ROOT_CONTEXT;

    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(
      traceparent.trim(),
    );
    if (!match) return ROOT_CONTEXT;

    return trace.setSpanContext(ROOT_CONTEXT, {
      traceId: match[1].toLowerCase(),
      spanId: match[2].toLowerCase(),
      traceFlags: parseInt(match[3], 16) as TraceFlags,
      isRemote: true,
    });
  }
}
