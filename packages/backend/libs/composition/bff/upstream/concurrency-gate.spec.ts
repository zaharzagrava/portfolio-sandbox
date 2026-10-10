import { ConcurrencyGate, type Release } from './concurrency-gate';

const gate = () => new ConcurrencyGate({ perUpstream: 3, perRequest: 2 });

describe('S48 AS-18 concurrency gate (unit)', () => {
  it('S48 AS-18: admits up to the per-upstream cap across requests and rejects beyond it', async () => {
    const g = gate();
    const held: (Release | null)[] = [];
    for (let i = 0; i < 3; i++)
      held.push(await g.acquire('catalog', g.forRequest()));
    expect(held.every((h) => h !== null)).toBe(true);
    expect(g.inFlight('catalog')).toBe(3);
    expect(await g.acquire('catalog', g.forRequest())).toBeNull();
  });

  it('S48 AS-18: releasing frees a slot, and releasing twice frees only one', async () => {
    const g = gate();
    const slots: (Release | null)[] = [];
    for (let i = 0; i < 3; i++)
      slots.push(await g.acquire('catalog', g.forRequest()));
    slots[0]!();
    slots[0]!();
    expect(g.inFlight('catalog')).toBe(2);
    expect(await g.acquire('catalog', g.forRequest())).not.toBeNull();
    expect(await g.acquire('catalog', g.forRequest())).toBeNull();
  });

  it('S48 AS-18: upstreams are counted separately', async () => {
    const g = gate();
    for (let i = 0; i < 3; i++) await g.acquire('catalog', g.forRequest());
    expect(await g.acquire('catalog', g.forRequest())).toBeNull();
    expect(await g.acquire('tenancy', g.forRequest())).not.toBeNull();
  });

  it.each([[1], [2]])(
    'S48 AS-18: a request holds at most two calls; extra ones wait for a slot (%s waiting)',
    async (extra) => {
      const g = gate();
      const request = g.forRequest();
      const a = await g.acquire('a', request);
      const b = await g.acquire('b', request);
      expect(request.inFlight).toBe(2);
      let admitted = 0;
      const waiting = Array.from({ length: extra }, () =>
        g.acquire('c', request).then((r) => {
          admitted++;
          return r;
        }),
      );
      await new Promise((r) => setImmediate(r));
      expect(admitted).toBe(0);
      expect(request.inFlight).toBe(2);
      a!();
      await new Promise((r) => setImmediate(r));
      expect(admitted).toBe(1);
      expect(request.inFlight).toBe(2);
      b!();
      await Promise.all(waiting);
      expect(admitted).toBe(extra);
    },
  );

  it('S48 AS-18: a refused upstream slot does not leak the request slot', async () => {
    const g = gate();
    for (let i = 0; i < 3; i++) await g.acquire('catalog', g.forRequest());
    const request = g.forRequest();
    expect(await g.acquire('catalog', request)).toBeNull();
    expect(request.inFlight).toBe(0);
  });
});
