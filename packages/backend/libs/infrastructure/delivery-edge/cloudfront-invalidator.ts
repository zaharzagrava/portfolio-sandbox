import { randomUUID } from 'node:crypto';
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront';

export interface CloudFrontInvalidatorOptions {
  distributionId: string;
  /** Only `send` is used; tests pass a stub. CloudFront is a global service, the client is built without a region lookup. */
  client?: Pick<CloudFrontClient, 'send'>;
  callerReference?: () => string;
}

/** `DELIVERY_EDGE_INVALIDATOR`: one `CreateInvalidation` per call; failures reject so the purge repeats the request. */
export function createCloudFrontInvalidator({
  distributionId,
  client = new CloudFrontClient({ region: 'us-east-1' }),
  callerReference = randomUUID,
}: CloudFrontInvalidatorOptions): (paths: string[]) => Promise<void> {
  return async (paths) => {
    await client.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: callerReference(),
          Paths: { Quantity: paths.length, Items: paths },
        },
      }),
    );
  };
}
