/**
 * Coordinates are personal data (W02 AS-31): rounded to three decimals (about 110 m) on write, held in memory only, and
 * never put in the address, a storage area, a log or an analytics event.
 */

export type Coords = { lat: number; lng: number };
export type Bounds = { south: number; west: number; north: number; east: number };

const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** Latitude/longitude to three decimals. */
export const roundCoords = ({ lat, lng }: Coords): Coords => ({ lat: round(lat, 3), lng: round(lng, 3) });

/** Map bounds to four decimals, for the clusters request. */
export const roundBounds = ({ south, west, north, east }: Bounds): Bounds => ({
  south: round(south, 4),
  west: round(west, 4),
  north: round(north, 4),
  east: round(east, 4),
});

/** Zoom as an integer in 0..20. */
export const clampZoom = (zoom: number): number => Math.min(20, Math.max(0, Math.round(Number.isFinite(zoom) ? zoom : 0)));
