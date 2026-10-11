import { clientEventBatchSchema } from '@marketplace-sandbox/contracts';
import { ClientBatch, ClientEvent } from './domain/event-schema';

const ok = (
  s: { safeParse: (v: unknown) => { success: boolean } },
  v: unknown,
) => s.safeParse(v).success;

// Typed with the backend's input type: drift in a shared field fails compilation.
const event: ClientEvent = {
  event_id: '0b5f6f0e-1111-4222-8333-444455556666',
  name: 'product_view',
  anonymous_id: 'AbCdEfGhIjKlMnOpQrStUv',
  ts: 1_790_000_000_000,
  page: '/products/airpods',
  props: { product_id: 'p1', category: 'audio', in_stock: true, price: 129 },
};

describe('W02 B-7: client event batch contract', () => {
  it('W02 B-7: a batch the backend ingest accepts parses with the contract too', () => {
    const batch = { events: [event, { ...event, name: 'video_view', props: undefined }] };
    expect(ok(clientEventBatchSchema, { events: [event] })).toBe(true);
    expect(ok(ClientBatch, { events: [event] })).toBe(true);
    expect(ok(clientEventBatchSchema, batch)).toBe(true);
  });

  it('W02 B-7: the batch holds 1 to 50 events', () => {
    expect(ok(clientEventBatchSchema, { events: [] })).toBe(false);
    expect(ok(clientEventBatchSchema, { events: Array(50).fill(event) })).toBe(true);
    expect(ok(clientEventBatchSchema, { events: Array(51).fill(event) })).toBe(false);
  });

  it('W02 B-7: event negatives mirror the backend: unknown name, non-uuid id, short anonymous id, 31 props, nested prop', () => {
    const bad = (patch: object) => ok(clientEventBatchSchema, { events: [{ ...event, ...patch }] });
    expect(bad({ name: 'purchase' })).toBe(false);
    expect(bad({ event_id: 'not-a-uuid' })).toBe(false);
    expect(bad({ anonymous_id: 'short' })).toBe(false);
    expect(bad({ ts: 1.5 })).toBe(false);
    expect(bad({ page: 'x'.repeat(501) })).toBe(false);
    expect(bad({ props: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, 'v'])) })).toBe(false);
    expect(bad({ props: { nested: { a: 1 } } })).toBe(false);
    expect(bad({ props: { k: 'x'.repeat(501) } })).toBe(false);
  });
});
