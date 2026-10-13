import {
  DeliveryEdge,
  DeliveryEdgeNotConfiguredError,
  SignedCookies,
} from './delivery-edge.port';

/** Bound when no key pair is configured (non-production only): every call fails with the typed error. */
export class UnconfiguredDeliveryEdge extends DeliveryEdge {
  signCookies(): Promise<SignedCookies> {
    return Promise.reject(new DeliveryEdgeNotConfiguredError());
  }

  invalidate(): Promise<void> {
    return Promise.reject(
      new DeliveryEdgeNotConfiguredError('invalidation path'),
    );
  }
}
