import { CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { CloudFrontDeliveryEdge } from './cloudfront-delivery-edge';
import { createCloudFrontInvalidator } from './cloudfront-invalidator';

describe('S30 SC-008: CloudFront invalidator', () => {
  it('S30 SC-008: sends one CreateInvalidation with the paths for the configured distribution', async () => {
    const send = jest.fn().mockResolvedValue({});
    const invalidate = createCloudFrontInvalidator({
      distributionId: 'E123',
      client: { send },
      callerReference: () => 'ref-1',
    });
    await invalidate(['/p/v1/*', '/p/v2/*']);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as CreateInvalidationCommand;
    expect(command).toBeInstanceOf(CreateInvalidationCommand);
    expect(command.input).toEqual({
      DistributionId: 'E123',
      InvalidationBatch: {
        CallerReference: 'ref-1',
        Paths: { Quantity: 2, Items: ['/p/v1/*', '/p/v2/*'] },
      },
    });
  });

  it('S30 SC-008: a CDN failure rejects so the purge repeats the request', async () => {
    const invalidate = createCloudFrontInvalidator({
      distributionId: 'E123',
      client: { send: jest.fn().mockRejectedValue(new Error('throttled')) },
    });
    await expect(invalidate(['/p/v1/*'])).rejects.toThrow('throttled');
  });

  it('S30 SC-008: the edge adapter passes paths through to it', async () => {
    const send = jest.fn().mockResolvedValue({});
    const edge = new CloudFrontDeliveryEdge({
      keyPairId: 'K',
      privateKey: 'x',
      invalidate: createCloudFrontInvalidator({
        distributionId: 'E9',
        client: { send },
      }),
    });
    await edge.invalidate(['/p/a/*']);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
