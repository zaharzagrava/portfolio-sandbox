import {
  CATALOG_SYNC_AGGREGATE_TYPE,
  importEventSchemas,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * S07's one event on the shared topic `catalogsync.events` (key `importId`). The spec names it
 * `catalog_sync.import_finished` on `catalog-sync.events`; the S53 patterns allow neither a `-` in an aggregate type nor
 * a `_` in the first segment of a type, so the registered name is `catalogsync.import_finished` (as S08's events;
 * gaps.md, Spec changes). Written once, in the transaction of the import's final status. The aggregate type is
 * registered once, by `EventsModule.forAggregates` in the integrations module; there is no second topic definition.
 */
export const ImportFinished = defineEvent(
  'catalogsync.import_finished',
  CATALOG_SYNC_AGGREGATE_TYPE,
  1,
  importEventSchemas['catalogsync.import_finished'],
);
