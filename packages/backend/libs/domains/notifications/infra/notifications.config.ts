/**
 * Cache options for records that must be seen by every process the moment they change (preference, suppression and
 * recipient-view data): no per-process copy (S52 `l1: 'never'`), shared tier only. The typed settings reader lives in
 * `application/notifications-settings.ts`.
 */
export const SHARED_RECORD_CACHE = { l1: 'never' as const };
