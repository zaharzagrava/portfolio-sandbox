import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import {
  assertSingleVideoPattern,
  DeliveryEdge,
  DeliveryEdgeNotConfiguredError,
  SignCookiesInput,
  SignedCookies,
} from './delivery-edge.port';

export interface CloudFrontEdgeOptions {
  keyPairId: string;
  /** PEM private key; literal `\n` sequences (single-line env values) are accepted. */
  privateKey: string;
  /** Sends the paths to CloudFront (CreateInvalidation). Injected: the client SDK is not a dependency of this repo yet. */
  invalidate: (paths: string[]) => Promise<void>;
}

/** CloudFront signed cookies with a custom policy: one resource pattern and one `DateLessThan`. */
export class CloudFrontDeliveryEdge extends DeliveryEdge {
  constructor(protected readonly options: CloudFrontEdgeOptions) {
    super();
  }

  signCookies({
    resourcePattern,
    expiresAt,
  }: SignCookiesInput): Promise<SignedCookies> {
    const { keyPairId, privateKey } = this.options;
    if (!keyPairId || !privateKey)
      return Promise.reject(new DeliveryEdgeNotConfiguredError());
    try {
      assertSingleVideoPattern(resourcePattern);
      const policy = JSON.stringify({
        Statement: [
          {
            Resource: resourcePattern,
            Condition: {
              DateLessThan: {
                'AWS:EpochTime': Math.floor(expiresAt.getTime() / 1000),
              },
            },
          },
        ],
      });
      return Promise.resolve(
        getSignedCookies({
          keyPairId,
          privateKey: privateKey.replace(/\\n/g, '\n'),
          policy,
        }) as SignedCookies,
      );
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  async invalidate(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.options.invalidate(paths);
  }
}
