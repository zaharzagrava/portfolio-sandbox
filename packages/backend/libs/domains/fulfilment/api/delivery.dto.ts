/**
 * Types of the delivery HTTP contract (S20 contracts/delivery-api.md). The schemas live in `packages/contracts`; this
 * file only re-exports the types controllers and the domain's entry point hand out.
 */
export type {
  AvailabilityRequest,
  CourierSelf,
  CourierView,
  LocationBatchRequest,
  LocationBatchResponse,
  RegisterCourierRequest,
} from '@marketplace-sandbox/contracts';
