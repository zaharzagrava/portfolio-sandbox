import { Controller, Query, Request, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { Firewall, UserUtilsService } from '@app/domains/identity';
import type { RequestWithUser } from '@app/domains/identity';
import { PaymentDtoService } from '@app/domains/payments';
import { DbUtilsService } from '@app/infrastructure/database/db-utils/db-utils.service';
import { RedisPubSubService } from '../redis-pubsub/redis-pubsub.service';

interface PaymentStreamEvent {
  idempotencyKey: string;
  status?: string;
  paymentId?: string;
  error?: unknown;
}

@Controller('payment')
export class PaymentStreamController {
  constructor(
    private readonly redisPubSubService: RedisPubSubService,
    private readonly paymentDtoService: PaymentDtoService,
    private readonly dbUtilsService: DbUtilsService,
    private readonly userUtilsService: UserUtilsService,
  ) {}

  @Firewall()
  // See README.md#adr -> "Why use Real-Time Push (SSE)?"
  @Sse('stream')
  stream(
    @Query('idempotencyKey') idempotencyKey: string,
    @Request() request: RequestWithUser,
  ): Observable<{ data: PaymentStreamEvent }> {
    const viewerUser = this.userUtilsService.getUser(request);

    return new Observable((subscriber) => {
      let unsubscribeFn: (() => Promise<void>) | undefined;
      let closed = false;

      const validateOwnershipThenListen = async () => {
        const existingPayment = await this.dbUtilsService.wrapInTransaction((tx) =>
          this.paymentDtoService.requestPaymentOptional({
            params: { idempotencyKey },
            tx,
          }),
        );

        // Payment.userId is denormalized from BisOrder, so no join is needed
        // (bisOrder isn't loaded here - comparing against it rejected everyone)
        if (existingPayment && existingPayment.userId !== viewerUser.id) {
          subscriber.error(new Error('Forbidden'));
          return;
        }

        unsubscribeFn = await this.redisPubSubService.subscribe(
          `payments:sse:${idempotencyKey}`,
          (message) => {
            if (closed) return;

            const event = JSON.parse(message) as PaymentStreamEvent;
            subscriber.next({ data: event });

            if (event.status && event.status !== 'PENDING') {
              subscriber.complete();
            }
          },
        );
      };

      validateOwnershipThenListen().catch((err) => subscriber.error(err));

      return () => {
        closed = true;
        void unsubscribeFn?.();
      };
    });
  }
}
