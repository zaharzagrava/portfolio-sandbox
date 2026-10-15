import { deriveWebhookEventId } from './webhook-events';

/** Low-stock rule (S43 FR-025, AS-28): decided from the snapshot alone, with no marker store. */
export const STOCK_LOW_THRESHOLD = 5;

export interface StockLowInput {
  productId: string;
  shopId: string;
  title: string;
  quantity: number;
  changedFields: readonly string[];
  isSandbox: boolean;
  /** Envelope `occurredAt`: the only source of the UTC day, so a replay of the same event decides the same way. */
  occurredAt: string;
}

export type StockLowDecision =
  | { emit: false }
  | {
      emit: true;
      /** `YYYY-MM-DD` of `occurredAt` in UTC. */
      utcDay: string;
      /**
       * Deterministic per (product, UTC day): a second qualifying snapshot of the day has the same id, so the delivery
       * record of (endpoint, event) already exists and nothing is delivered twice.
       */
      eventId: string;
      object: Record<string, unknown>;
      resourceVersion: null;
    };

export const stockLowEventId = (productId: string, utcDay: string): string =>
  deriveWebhookEventId('stock_low', productId, utcDay);

/** Emit when `quantity <= 5`, `quantity` is among the changed fields and the snapshot is not a sandbox one. */
export function decideStockLow(input: StockLowInput): StockLowDecision {
  if (input.isSandbox) return { emit: false };
  if (input.quantity > STOCK_LOW_THRESHOLD) return { emit: false };
  if (!input.changedFields.includes('quantity')) return { emit: false };
  const at = new Date(input.occurredAt);
  if (Number.isNaN(at.getTime())) return { emit: false };
  const utcDay = at.toISOString().slice(0, 10);
  return {
    emit: true,
    utcDay,
    eventId: stockLowEventId(input.productId, utcDay),
    object: {
      id: input.productId,
      object: 'product',
      title: input.title,
      stock: input.quantity,
      threshold: STOCK_LOW_THRESHOLD,
    },
    resourceVersion: null,
  };
}
