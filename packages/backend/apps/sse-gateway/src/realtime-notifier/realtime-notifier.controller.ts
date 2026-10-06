import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { RedisPubSubService } from '../redis-pubsub/redis-pubsub.service';

interface OutboxEventEnvelope {
  payload: { idempotency_key?: string; idempotencyKey?: string };
  extra?: { payment?: { id: string; status: string } };
  error?: unknown;
}

@Controller()
export class RealtimeNotifierController {
  private readonly l = new Logger(RealtimeNotifierController.name);

  constructor(private readonly redisPubSubService: RedisPubSubService) {}

  @EventPattern('payments.responses')
  async handleResponse(@Payload() data: OutboxEventEnvelope) {
    await this.relay(data);
  }

  @EventPattern('payments.dlq')
  async handleDlq(@Payload() data: OutboxEventEnvelope) {
    await this.relay(data);
  }

  private async relay(data: OutboxEventEnvelope): Promise<void> {
    const idempotencyKey =
      data.payload?.idempotency_key ?? data.payload?.idempotencyKey;

    if (!idempotencyKey) {
      this.l.warn('Outbox event missing idempotency key, dropping', { data });
      return;
    }

    await this.redisPubSubService.publish(`payments:sse:${idempotencyKey}`, {
      idempotencyKey,
      status: data.extra?.payment?.status,
      paymentId: data.extra?.payment?.id,
      error: data.error,
    });
  }
}
