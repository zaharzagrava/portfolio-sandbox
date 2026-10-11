import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clampZoom, roundBounds, roundCoords } from './coords';

describe('coordinates', () => {
  it('W02 AS-31: latitude and longitude are rounded to three decimals', () => {
    expect(roundCoords({ lat: 52.520008, lng: 13.404954 })).toEqual({ lat: 52.52, lng: 13.405 });
    expect(roundCoords({ lat: -33.8688197, lng: 151.2092955 })).toEqual({ lat: -33.869, lng: 151.209 });
  });

  it('W02 AS-31: a value already at three decimals is unchanged and negative zero becomes zero', () => {
    expect(roundCoords({ lat: 1.234, lng: -0.0001 })).toEqual({ lat: 1.234, lng: 0 });
    expect(Object.is(roundCoords({ lat: -0.0001, lng: 0 }).lat, 0)).toBe(true);
  });

  it('W02 AS-42: map bounds are rounded to four decimals', () => {
    expect(roundBounds({ south: 52.123456, west: 13.123456, north: 52.987654, east: 13.987654 })).toEqual({
      south: 52.1235,
      west: 13.1235,
      north: 52.9877,
      east: 13.9877,
    });
  });

  it('W02 AS-42: zoom is an integer from 0 to 20', () => {
    expect(clampZoom(11.6)).toBe(12);
    expect(clampZoom(-3)).toBe(0);
    expect(clampZoom(25)).toBe(20);
    expect(clampZoom(Number.NaN)).toBe(0);
  });

  it('W02 AS-31: the module keeps no copy of the coordinates (pure functions, no storage)', () => {
    const source = readFileSync(path.resolve(__dirname, 'coords.ts'), 'utf8');
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|console\./);
  });
});
