import type { AdClickRecord } from '@marketplace-sandbox/contracts';

/** The value of `ads.clicks` (snake_case, as ClickHouse consumes it); the schema lives in `packages/contracts`. */
export type ClickRecord = AdClickRecord;

/** `received_at` as ClickHouse `DateTime64(3)` reads it: `YYYY-MM-DD HH:mm:ss.SSS`, UTC. */
export const formatReceivedAt = (at: Date): string =>
  at.toISOString().replace('T', ' ').replace('Z', '');

/** `YYYY-MM-DDTHH` of an instant, UTC: the billing hour key and the ledger reference suffix. */
export const hourKey = (at: Date): string => at.toISOString().slice(0, 13);

/** The instant an `hourKey` names. */
export const hourStart = (key: string): Date => new Date(`${key}:00:00.000Z`);

/** `YYYY-MM-DD` of an instant, UTC. */
export const dayKey = (at: Date): string => at.toISOString().slice(0, 10);

export const dayStart = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** `ad:<campaign>:<YYYY-MM-DDTHH>`: the ledger reference of an hourly charge (FR-041). */
export const chargeReference = (campaignId: string, hour: Date): string =>
  `ad:${campaignId}:${hourKey(hour)}`;

/** `ad-adj:<campaign>:<YYYY-MM-DDTHH>:<sequence>`: the ledger reference of an adjustment (FR-051). */
export const adjustmentReference = (
  campaignId: string,
  hour: Date,
  sequence: number,
): string => `ad-adj:${campaignId}:${hourKey(hour)}:${sequence}`;
