import { keyShapes, RING_KEY } from './courier-keys';

describe('Courier key shapes (cell isolation)', () => {
  const ids = { courierId: 'c-1', deliveryId: 'd-1', minute: 29_000_000 };

  it.each(['berlin', 'sao-paulo', 'a1'])(
    'S20 AS-54: every per-city key of %s has the city as its one hash tag',
    (city) => {
      const shapes = keyShapes(city, ids);

      expect(Object.keys(shapes)).toEqual([
        'geoKey',
        'courierKey',
        'offerLockKey',
        'trackThrottleKey',
        'surgeKey',
        'demandKey',
      ]);
      for (const key of Object.values(shapes))
        expect(key.match(/\{[^{}]*\}/g)).toEqual([`{${city}}`]);
    },
  );

  it('S20 AS-54: the keys of two cities never share a tag', () => {
    const a = Object.values(keyShapes('berlin', ids));
    const b = Object.values(keyShapes('hamburg', ids));

    expect(a.filter((key) => b.includes(key))).toEqual([]);
  });

  it('S20 AS-53: the ring key is the one key without a city tag', () => {
    expect(RING_KEY).not.toMatch(/[{}]/);
  });
});
