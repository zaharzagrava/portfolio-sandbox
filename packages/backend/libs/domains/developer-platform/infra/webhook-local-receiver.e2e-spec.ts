import { startStandIn, StandIn } from '@app/test/toolkit/stand-in-server';
import { DEFAULT_WEBHOOK_SETTINGS } from '../domain/webhook-settings';
import { SafeAddressGuard } from './safe-address.guard';
import { SafeOutboundHttpAdapter } from './safe-outbound-http.adapter';

/**
 * J02 G-32: the local profile's `allowedReceiverHosts` lets the journey's HTTPS receiver (a loopback address, its own
 * port, a self-signed certificate) be registered and called, and nothing else.
 */
describe('webhook receivers on the local profile (allowedReceiverHosts)', () => {
  let receiver: StandIn;
  const clock = { now: () => new Date(), nowMs: () => Date.now() };

  beforeAll(async () => {
    receiver = await startStandIn({ tlsHosts: ['receiver.example'] });
    receiver.setHandler((_req, res) => void res.writeHead(200).end('{}'));
  });
  afterAll(() => receiver.close());

  const listed = () => ({
    ...DEFAULT_WEBHOOK_SETTINGS,
    allowedReceiverHosts: [`127.0.0.1:${receiver.port}`],
  });
  const request = (port = receiver.port) => ({
    url: `https://127.0.0.1:${port}/hook`,
    headers: { 'content-type': 'application/json' },
    body: '{}',
    timeoutMs: 2_000,
    maxResponseBytes: 1024,
  });

  it('S43 G-32: the save-time lookup guard accepts a listed host (the host:port syntax rule is parseEndpointUrl)', async () => {
    const guard = new SafeAddressGuard(listed(), {});
    expect(await guard.check(request().url)).toEqual({ ok: true });
  });

  it('S43 G-32: without the setting the same address is refused', async () => {
    const guard = new SafeAddressGuard(DEFAULT_WEBHOOK_SETTINGS, {});
    expect((await guard.check(request().url)).ok).toBe(false);
  });

  it('S43 G-32: a delivery reaches the listed receiver over https although its certificate is self-signed', async () => {
    const adapter = new SafeOutboundHttpAdapter(clock as never, listed(), {});
    const result = await adapter.post(request());
    expect(result).toMatchObject({ kind: 'response', status: 200 });
    expect(receiver.requests.at(-1)?.body.toString()).toBe('{}');
  });

  it('S43 G-32: without the setting the delivery fails as a typed result, not an exception', async () => {
    const adapter = new SafeOutboundHttpAdapter(
      clock as never,
      DEFAULT_WEBHOOK_SETTINGS,
      {},
    );
    expect(await adapter.post(request())).toMatchObject({ kind: 'failure' });
  });
});
