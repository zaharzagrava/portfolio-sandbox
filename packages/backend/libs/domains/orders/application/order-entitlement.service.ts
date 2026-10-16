import { Inject, Injectable } from '@nestjs/common';
import { ORDER_REPOSITORY, type OrderRepository } from '../domain/ports';

/** Purchase facts for other capabilities (R1): what a buyer has paid for. No order leaves the domain. */
@Injectable()
export class OrderEntitlementService {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
  ) {}

  /** Whether the user has a paid order that includes the product (a cancelled or unpaid order does not count). */
  hasPurchased(userId: string, productId: string): Promise<boolean> {
    return this.orders.hasPaidItem(userId, productId);
  }
}
