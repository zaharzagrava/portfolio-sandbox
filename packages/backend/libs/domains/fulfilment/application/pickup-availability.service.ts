import { Inject, Injectable } from '@nestjs/common';
import { PICKUP_LIMITS } from '@marketplace-sandbox/contracts';
import {
  PICKUP_STOCK_REPOSITORY,
  type PickupShortage,
  type PickupStockRepository,
} from '../domain/pickup-ports';
import {
  InvalidAvailabilityRequestError,
  PickupPointNotFoundError,
} from '../domain/pickup-errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINES = 50;

export interface AvailabilityLine {
  productId: string;
  quantity: number;
}

export interface AvailabilityAnswer {
  available: boolean;
  reason?: 'pickup_point_inactive';
  shortages: PickupShortage[];
}

/**
 * The reservation-time exact check (S19 FR-040, R1): does this point hold these quantities right now? It reads the
 * exact store in one statement and is never stale, unlike the search index. For a later pickup checkout; nothing calls
 * it today.
 */
@Injectable()
export class PickupAvailabilityService {
  constructor(
    @Inject(PICKUP_STOCK_REPOSITORY)
    private readonly stock: PickupStockRepository,
  ) {}

  /**
   * @throws PickupPointNotFoundError for an unknown point
   * @throws InvalidAvailabilityRequestError for 0 or more than 50 lines, a quantity that is not an integer from 1, a
   *   product id that is not a UUID, or a product named twice
   */
  async checkAvailability(
    pickupPointId: string,
    lines: AvailabilityLine[],
  ): Promise<AvailabilityAnswer> {
    this.validate(pickupPointId, lines);
    const found = await this.stock.checkLines(pickupPointId, lines);
    if (!found) throw new PickupPointNotFoundError();
    if (!found.active)
      return {
        available: false,
        reason: 'pickup_point_inactive',
        shortages: [],
      };
    return {
      available: found.shortages.length === 0,
      shortages: found.shortages,
    };
  }

  private validate(pickupPointId: string, lines: AvailabilityLine[]): void {
    if (
      !UUID.test(pickupPointId) ||
      !Array.isArray(lines) ||
      lines.length < 1 ||
      lines.length > MAX_LINES ||
      !lines.every(
        (l) =>
          typeof l?.productId === 'string' &&
          UUID.test(l.productId) &&
          Number.isInteger(l.quantity) &&
          l.quantity >= 1 &&
          l.quantity <= PICKUP_LIMITS.stockMax,
      ) ||
      new Set(lines.map((l) => l.productId.toLowerCase())).size !== lines.length
    )
      throw new InvalidAvailabilityRequestError();
  }
}
