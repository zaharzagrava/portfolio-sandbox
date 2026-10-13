/**
 * DTOs of the pickup HTTP API: the contract schemas' inferred types are the single definition (S19 FR-028, A24).
 * Nothing is declared twice; controllers parse with the schemas and services return these shapes.
 */
export {
  pickupBrowseQuerySchema,
  pickupClusterQuerySchema,
  pickupListQuerySchema,
  pickupPointCreateSchema,
  pickupPointPatchSchema,
  pickupSearchQuerySchema,
  pickupStockAdjustSchema,
  pickupStockSetSchema,
} from '@marketplace-sandbox/contracts';
export type {
  PickupClusterCell,
  PickupClustersResponse,
  PickupNearItem,
  PickupNearSearchResponse,
  PickupPoint,
  PickupPointCreate,
  PickupPointNear,
  PickupPointPage,
  PickupPointPatch,
  PickupPointsNearResponse,
  PickupStock,
  PickupStockAdjust,
  PickupStockAdjusted,
  PickupStockPage,
  PickupStockSet,
} from '@marketplace-sandbox/contracts';
