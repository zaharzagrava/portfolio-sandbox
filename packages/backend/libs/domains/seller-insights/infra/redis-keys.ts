import type { Period } from '../domain/periods';

/**
 * Everything for one period shares the hash tag `{<periodId>}`: one script updates every board of the period on one
 * cluster slot. Every key of a period expires at the period end plus 35 days (S40 FR-010).
 */
const tag = (period: Pick<Period, 'id'>) => `{${period.id}}`;

export const boardKey = (period: Pick<Period, 'id'>, board: string) =>
  `lb:${tag(period)}:z:${board}`;
/** Revenue per `board|shopId`. */
export const revenueKey = (period: Pick<Period, 'id'>) =>
  `lb:${tag(period)}:rev`;
/** Latest sale slot per `board|shopId` (never moves back). */
export const lastSlotKey = (period: Pick<Period, 'id'>) =>
  `lb:${tag(period)}:last`;
/** Applied order ids. */
export const appliedKey = (period: Pick<Period, 'id'>) =>
  `lb:${tag(period)}:applied`;
/** The boards that exist in the period. */
export const boardsKey = (period: Pick<Period, 'id'>) =>
  `lb:${tag(period)}:boards`;
export const sealedKey = (period: Pick<Period, 'id'>) =>
  `lb:${tag(period)}:sealed`;
export const BOARDS_KEY_PATTERN = 'lb:{*}:boards';

export const LIVE_BUCKET_TTL_SEC = 180;
export const LIVE_MARK_TTL_SEC = 180;
export const liveBucketKey = (shopId: string, second: number) =>
  `live:{${shopId}}:${second}`;
export const liveMarkKey = (shopId: string, eventId: string, kind: string) =>
  `live:{${shopId}}:seen:${eventId}:${kind}`;
export const liveLeaseKey = (shopId: string) => `live:{${shopId}}:lease`;
export const LIVE_SHOP_PATTERN = (shopId: string) => `live:{${shopId}}:*`;
export const LIVE_SUBSCRIBED_FALLBACK_KEY = 'live:subscribed';
