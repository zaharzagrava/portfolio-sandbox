import { CloudFrontDeliveryEdge } from './cloudfront-delivery-edge';
import { SignCookiesInput } from './delivery-edge.port';

/**
 * Test adapter: signs with the real signer and a caller-provided (throwaway) RSA key so tests can verify the
 * signature; records every signing and invalidation request; invalidations can be made to fail.
 */
export class InMemoryDeliveryEdge extends CloudFrontDeliveryEdge {
  readonly signed: SignCookiesInput[] = [];
  readonly invalidations: string[][] = [];
  private failure?: Error;

  constructor(options: { keyPairId: string; privateKey: string }) {
    super({
      ...options,
      invalidate: (paths) => {
        if (this.failure) return Promise.reject(this.failure);
        this.invalidations.push([...paths]);
        return Promise.resolve();
      },
    });
  }

  private signingFailure?: Error;

  override async signCookies(input: SignCookiesInput) {
    if (this.signingFailure) throw this.signingFailure;
    const cookies = await super.signCookies(input);
    this.signed.push(input);
    return cookies;
  }

  /** Makes every following `signCookies` throw `error` (a missing key pair); `undefined` restores signing. */
  failSigning(error: Error | undefined): void {
    this.signingFailure = error;
  }

  /** Makes every following `invalidate` reject with `error`; `undefined` restores success. */
  failInvalidations(error: Error | undefined): void {
    this.failure = error;
  }
}
