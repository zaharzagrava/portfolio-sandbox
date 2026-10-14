import { Injectable } from '@nestjs/common';
import {
  OrderCommandRejectedError,
  OrderCommandService,
} from '@app/domains/orders';
import type {
  OrderRequest,
  OrderRequestPort,
  OrderRequestResult,
} from '../domain/auction-ports';

/**
 * The winner's (or runner-up's) order through orders' exported command (S10 amendment, S21 FR-028): one idempotent
 * command with a stable key. A typed rejection is permanent (the buyer or the shop cannot be served); anything else is
 * thrown as it is, the job retries with backoff.
 */
@Injectable()
export class OrderRequestAdapter implements OrderRequestPort {
  constructor(private readonly orders: OrderCommandService) {}

  async request(command: OrderRequest): Promise<OrderRequestResult> {
    try {
      const answer = await this.orders.createFixedPriceOrder({
        idempotencyKey: command.idempotencyKey,
        buyerId: command.buyerId,
        shopId: command.shopId,
        productId: command.productId,
        quantity: 1,
        unitPriceMinor: command.unitPriceMinor,
        currency: command.currency,
        titleSnapshot: command.titleSnapshot,
        reservedUntil: command.reservedUntil.toISOString(),
        origin: {
          kind: 'AUCTION',
          ref: command.auctionId,
          step: command.step,
        },
        stockHandling: 'EXTERNALLY_HELD',
      });
      return { ok: true, orderId: answer.orderId, replayed: answer.replayed };
    } catch (error) {
      if (error instanceof OrderCommandRejectedError)
        return { ok: false, permanent: true, code: error.code };
      throw error;
    }
  }
}
