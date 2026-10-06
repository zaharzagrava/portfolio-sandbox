import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { DbUtilsService } from '@app/infrastructure/database/db-utils/db-utils.service';
import { PaymentDtoService } from '../infra/payment-dto.service';
import {
  Domain_StripePaymentFailed,
  Domain_InsufficientStockError,
  PostPaymentParamsDto,
  PostPaymentResponseDto,
} from '../api/payment.dto';
import Payment, { PaymentStatus } from '../infra/models/payment.model';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';
import {
  Fatal_NotFoundError,
  ErrorArea,
  Fatal_BadRequestError,
  Fatal_InternalServerError,
} from '@app/common/errors/error.types';
import { LedgerService } from './ledger.service';
import { KafkaTopicGroup } from '@app/infrastructure/outbox/outbox.model';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { BisUtilsService } from './bis-utils.service';
import { Sequelize } from 'sequelize';
import { trace, context as otelContext, Span } from '@opentelemetry/api';
import { runInSpan } from '../infra/tracing.utils';
import { LEDGER_ACCOUNTS, PLATFORM_FEE_MINOR } from '../domain/accounts';

@Injectable()
export class PaymentService {
  private readonly l = new Logger(PaymentService.name);

  constructor(
    private readonly dbUtilsService: DbUtilsService,
    private readonly paymentDtoService: PaymentDtoService,
    private readonly stripeService: StripeService,
    private readonly ledgerService: LedgerService,
    private readonly outboxService: OutboxService,
    private readonly bisUtilsService: BisUtilsService,
    @InjectConnection() private readonly sequelizeInstance: Sequelize,
    @InjectModel(Payment) private readonly paymentModel: typeof Payment,
  ) { }

  /**
   *
   * @description
   *    - by SHUTDOWN I mean when the server shuts down while executing this function. And it shutdowns ungracefully, meaning
   *      without sending a SIGTERM or SIGINT signal. For example, if the server is running on a VM, and the VM is powered off, or
   *      if the server itself is physically unplugged.
   *
   * @param param0
   * @returns
   */
  public async executePayment({
    params,
    topic,
    activeSpan,
  }: {
    params: PostPaymentParamsDto;
    topic: KafkaTopicGroup;
    activeSpan: Span;
  }): Promise<PostPaymentResponseDto> {
    if (!activeSpan) throw new Error('Active span is required');

    return await runInSpan(
      'PaymentService.executePayment',
      async (mainSpan) => {
        const { idempotency_key, amount, bisOrderId, userId, paymentMethodId, productId, quantity = 1 } = params;

        // 1. Automatic Fail-Fast Validation
        if (!idempotency_key) {
          // Marked as fatal, since our internal cloudflare gateway has to send idempotency key in the request headers,
          // and if it's missing - then it's not a business logic error, but an internal error on our side
          throw new Fatal_BadRequestError({
            detail: 'Idempotency key is missing',
            title: 'Idempotency key is missing',
          });
        }

        mainSpan.setAttribute('payment.idempotency_key', idempotency_key);
        mainSpan.setAttribute('payment.amount', amount);

        const payment = await runInSpan('Check Existing Payment', async () => {
          // Check for existing payment
          return await this.dbUtilsService.wrapInTransaction(async (tx) => {
            // If SHUTDOWN happens here - the transaction is rolled back, and kafka cursor doesn't move, and the service retries creating the same payment again
            // In case we have two identical events (due to user spamming the API etc.), the second event will get created payment record and later return it
            // See README.md#adr -> "Why implement idempotency keys?"
            await this.sequelizeInstance.query(
              `
            INSERT INTO "Payment" ("id", "idempotencyKey", "amount", "status", "bisOrderId", "userId", "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), :idempotencyKey, :amount, :status, :bisOrderId, :userId, NOW(), NOW())
            ON CONFLICT ("idempotencyKey") DO NOTHING;
          `,
              {
                replacements: {
                  idempotencyKey: idempotency_key,
                  amount,
                  status: PaymentStatus.PENDING,
                  bisOrderId,
                  userId,
                },
                transaction: tx,
              },
            );

            return await this.paymentDtoService.requestPayment({
              params: {
                idempotencyKey: idempotency_key,
                bisOrderFilters: {},
                bisOrderRequired: true,
              },
              tx,
            });
          });
        });

        /**
         * If SHUTDOWN happens right after creation - we still have this new payment in the DB with pending state, and
         * once the next service instance retries it, it will see the payment in PENDING state and proceed further
         */

        // If the payment is already COMPLETED or FAILED from a previous run, return it.
        // UNKNOWN continues: re-sending with the SAME Stripe idempotency key returns the
        // original outcome instead of charging again - the redelivery IS the status query (SD-20).
        if (payment.status !== PaymentStatus.PENDING && payment.status !== PaymentStatus.UNKNOWN) {
          return { payment: payment };
        }

        // Cheap fail-fast pre-check: avoids an unnecessary Stripe charge+refund
        // round-trip in the common (non-racing) case. Provides no concurrency
        // guarantee by itself — the real guarantee is the version-checked
        // decrement inside the Finalize Transaction below.
        if (productId) {
          const [stockRows] = await this.sequelizeInstance.query(
            `SELECT quantity FROM "Product" WHERE id = :productId`,
            { replacements: { productId } },
          );
          const stockRow = (stockRows as any[])[0];

          if (!stockRow || stockRow.quantity < quantity) {
            await this.outboxService.notify({
              topic,
              payload: params,
              extra: { payment },
              error: new Domain_InsufficientStockError({
                detail: `Product ${productId} has insufficient stock`,
              }),
            });

            return { payment };
          }
        }

        /**
         * We call VISA without holding a DB connection captive
         * If SHUTDOWN happens here - we don't have to know whether this API was called and with which response, since
         * VISA has its own idempotency key, and it will return existing response if the request is made again.
         */
        let stripeResponse: Awaited<ReturnType<StripeService['createPaymentIntent']>>;
        try {
          stripeResponse = await runInSpan(
            'Stripe: Create Payment Intent',
            async () => {
              return await this.stripeService.createPaymentIntent({
                amount,
                idempotencyKey: idempotency_key,
                paymentMethodId: paymentMethodId,
              });
            },
          );
        } catch (error) {
          // SD-20: a timeout is not a failure - the card may have been charged. Mark UNKNOWN
          // (visible to support/UI) and let the Kafka retry / resolver job settle it.
          if (this.stripeService.isUnknownOutcome(error)) {
            await this.paymentModel.update(
              { status: PaymentStatus.UNKNOWN },
              { where: { id: payment.id, status: PaymentStatus.PENDING } },
            );
          }
          throw error;
        }

        const finalizeResult = (await runInSpan('Finalize Transaction', async () => {
          return await this.dbUtilsService.wrapInTransaction(async (tx) => {
            const isSuccess = stripeResponse.status === 'succeeded';

            if (isSuccess && productId) {
              // See README.md#adr -> "Why use Optimistic Concurrency Control (OCC) instead of pessimistic locks?"
              const [, occResult] = await this.sequelizeInstance.query(
                `UPDATE "Product" SET quantity = quantity - :quantity, version = version + 1
                 WHERE id = :productId AND quantity >= :quantity
                 RETURNING id`,
                { replacements: { productId, quantity }, transaction: tx },
              );

              const rowCount = (occResult as any)?.rowCount ?? 0;

              if (rowCount === 0) {
                // Stock lost the race after Stripe already charged. Return here,
                // before the status-update block below ever touches Payment — it
                // stays PENDING. The refund happens outside this transaction, then
                // a follow-up transaction marks REFUNDED (see executePayment's
                // caller below).
                return {
                  payment,
                  needsRefund: true,
                  stripePaymentIntentId: stripeResponse.id,
                };
              }
            }

            try {
              // Attempt to update only if the payment is still in a PENDING state
              await this.paymentDtoService.update({
                where: { id: payment.id, status: [PaymentStatus.PENDING, PaymentStatus.UNKNOWN] },
                params: {
                  status: isSuccess
                    ? PaymentStatus.COMPLETED
                    : PaymentStatus.FAILED,
                  providerRef: stripeResponse.id ?? null,
                },
                tx,
              });
            } catch (error) {
              // If 0 rows are updated, the service throws a Domain_NotFoundError.
              if (error instanceof Fatal_NotFoundError) {
                const existingPayment = await this.paymentDtoService.findOne(
                  { id: payment.id },
                  tx,
                );

                // If the record doesn't exist, it's an exception, and must be investigated
                if (!existingPayment) {
                  throw new Fatal_InternalServerError({
                    detail: 'Payment is not found',
                    title: 'Payment is not found',
                    causes: [error]
                  });
                }

                // Other process has already processed the payment, and we return the existing state
                return { payment: existingPayment };
              }

              // Rethrow any other unexpected database or network errors
              throw error;
            }

            if (isSuccess) {
              // See README.md#adr -> "Why use double-entry bookkeeping?"
              await this.ledgerService.recordMarketplaceSale({
                paymentId: payment.id,
                buyerAccountId: this.bisUtilsService.getMerchantAccountId(
                  payment.bisOrder.userId,
                ),
                // SD-20: customer money lands in CLEARING; per-shop settlement on order.paid moves it to SHOP_<id> accounts.
                merchantAccountId: LEDGER_ACCOUNTS.CLEARING,
                platformRevenueAccountId: LEDGER_ACCOUNTS.PLATFORM_FEES,
                totalAmount: amount,
                feeAmount: PLATFORM_FEE_MINOR,
                tx,
              });

              payment.status = PaymentStatus.COMPLETED;

              // See README.md#adr -> "Why do you use the Outbox pattern alongside Kafka?" 
              // Example: The Payment status update above and this Outbox insert happen in the same DB transaction 'tx', guaranteeing they NEVER get lost.
              await this.outboxService.notify(
                {
                  topic: topic,
                  payload: params,
                  extra: { payment },
                },
                tx,
              );
            } else {
              payment.status = PaymentStatus.FAILED;

              const lastPaymentError = stripeResponse.last_payment_error;

              if (!lastPaymentError) {
                throw new Fatal_InternalServerError({
                  detail: 'Stripe did not provide with last payment error',
                  title: 'Stripe did not provide with last payment error',
                  causes: [new Error('Stripe did not provide with last payment error')],
                });
              }

              await this.outboxService.notify(
                {
                  topic: topic,
                  extra: { payment, stripeResponse },
                  payload: params,
                  // Domain errors are not forwarded to the DLQ, they are recorded in DB and communicated to the client
                  error: new Domain_StripePaymentFailed({
                    detail: lastPaymentError.message ?? 'Unknown error',
                    title: 'Stripe payment failed',
                    causes: [lastPaymentError],
                  }),
                },
                tx,
              );
            }

            return { payment };
          });
        })) as
          | PostPaymentResponseDto
          | { payment: Payment; needsRefund: true; stripePaymentIntentId: string };

        if ('needsRefund' in finalizeResult && finalizeResult.needsRefund) {
          // See README.md#adr -> "Why use a Distributed Saga instead of 2-Phase Commits?"
          await runInSpan('Refund: Insufficient Stock', async () => {
            await this.stripeService.refundPaymentIntent({
              paymentIntentId: finalizeResult.stripePaymentIntentId,
              idempotencyKey: idempotency_key,
            });
          });

          return await this.dbUtilsService.wrapInTransaction(async (tx) => {
            await this.paymentDtoService.update({
              where: { id: payment.id, status: PaymentStatus.PENDING },
              params: { status: PaymentStatus.REFUNDED },
              tx,
            });

            const refundedPayment = { ...payment.toJSON(), status: PaymentStatus.REFUNDED };

            await this.outboxService.notify(
              {
                topic,
                payload: params,
                extra: { payment: refundedPayment },
                error: new Domain_InsufficientStockError({
                  detail: `Stock ran out for product ${productId} after payment succeeded — refunded`,
                }),
              },
              tx,
            );

            return { payment: refundedPayment };
          });
        }

        return finalizeResult;
      },
      activeSpan,
    );

    /**
     * If SHUTDOWN happens here - the kafka reruns this event, but we have the payment in SUCCESS or FAILED state, so
     * we receive it in the first transaction of this function, and return it right away.
     */
  }
}
