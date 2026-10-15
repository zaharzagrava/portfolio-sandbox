export const CURSOR_REPOSITORY = Symbol('CURSOR_REPOSITORY');

export interface CursorState {
  integrationId: string;
  entity: string;
  watermark: Date | null;
  pageCursor: string | null;
  leaseHolder: string | null;
  leaseExpiresAt: Date | null;
  fence: number;
}

/** Lease-fenced sync cursor (one runner per integration/entity). Every write below carries the fence it was granted. */
export interface CursorRepository {
  read(integrationId: string, entity: string): Promise<CursorState | null>;
  /**
   * Reconnect (AS-09): forgets the watermark and the page checkpoint so the next pull starts from the beginning. The
   * lease and the fence are kept, so a run in flight loses its fenced writes.
   */
  reset(integrationId: string, entity: string): Promise<void>;
  /** Free or expired lease -> new holder and `fence + 1`; otherwise `null`. */
  claimLease(
    integrationId: string,
    entity: string,
    holder: string,
    ttlMs: number,
    now: Date,
  ): Promise<number | null>;
  renewLease(
    integrationId: string,
    entity: string,
    holder: string,
    fence: number,
    ttlMs: number,
    now: Date,
  ): Promise<boolean>;
  releaseLease(
    integrationId: string,
    entity: string,
    holder: string,
    fence: number,
  ): Promise<boolean>;
  /** `UPDATE ... WHERE fence = :fence`; `false` = the lease was lost. */
  checkpoint(
    integrationId: string,
    entity: string,
    fence: number,
    pageCursor: string | null,
  ): Promise<boolean>;
  /**
   * Alert latch of one episode (AS-66): `true` when this call set it (first alert), `false` when it was set already.
   * Stored as a cursor row of its own entity, so it needs no column.
   */
  markAlert(integrationId: string, entity: string, now: Date): Promise<boolean>;
  /** Re-arms the latch (the lag recovered). */
  clearAlert(integrationId: string, entity: string): Promise<void>;
  /** `watermark = GREATEST(watermark, :value)` and clears the page cursor, `WHERE fence = :fence`. */
  advanceWatermark(
    integrationId: string,
    entity: string,
    fence: number,
    value: Date,
  ): Promise<boolean>;
}
