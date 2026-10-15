export const RECEIPT_REPOSITORY = Symbol('RECEIPT_REPOSITORY');

export interface ReceiptRepository {
  /** `INSERT ... ON CONFLICT DO NOTHING`: `true` = first delivery, `false` = duplicate. */
  insertIfNew(
    integrationId: string,
    deliveryId: string,
    receivedAt: Date,
  ): Promise<boolean>;
  /** Undo of this request's own receipt after an enqueue failure. */
  remove(integrationId: string, deliveryId: string): Promise<void>;
  /** Retention (7 days). Returns the deleted count. */
  purgeReceivedBefore(before: Date, limit: number): Promise<number>;
}
