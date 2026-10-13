import {
  parseBrowseQuery,
  parseClusterQuery,
  parseListQuery,
  parseNearQuery,
} from './geo-input';

const base = { lat: '52.5219', lng: '13.4132' };

describe('S19 AS-04 near query', () => {
  it('applies the defaults and converts the numbers', () => {
    expect(parseNearQuery(base)).toEqual({
      ok: true,
      value: { lat: 52.5219, lng: 13.4132, radiusKm: 5, limit: 20 },
    });
  });

  it.each([
    ['q', { q: 'airpods' }, 'airpods'],
    ['q with spaces around', { q: '  airpods  ' }, 'airpods'],
    ['blank q', { q: '   ' }, undefined],
    ['empty q', { q: '' }, undefined],
  ])('reads %s', (_name, extra, q) => {
    const result = parseNearQuery({ ...base, ...extra });
    expect(result.ok && result.value.q).toBe(q);
  });

  it.each([
    ['lat missing', { lng: '13.4' }, ['lat']],
    ['lat text', { ...base, lat: 'north' }, ['lat']],
    ['lat above 90', { ...base, lat: '90.5' }, ['lat']],
    ['lat below -90', { ...base, lat: '-91' }, ['lat']],
    ['lat exponent', { ...base, lat: '1e1' }, ['lat']],
    ['lng missing', { lat: '52.5' }, ['lng']],
    ['lng above 180', { ...base, lng: '180.1' }, ['lng']],
    ['lng text', { ...base, lng: '' }, ['lng']],
    ['radius text', { ...base, radiusKm: 'far' }, ['radiusKm']],
    ['radius below 0.1', { ...base, radiusKm: '0.05' }, ['radiusKm']],
    ['radius above 50', { ...base, radiusKm: '50.1' }, ['radiusKm']],
    ['radius zero', { ...base, radiusKm: '0' }, ['radiusKm']],
    ['q over 100 characters', { ...base, q: 'a'.repeat(101) }, ['q']],
    ['limit fractional', { ...base, limit: '2.5' }, ['limit']],
    ['limit zero', { ...base, limit: '0' }, ['limit']],
    ['limit above 50', { ...base, limit: '51' }, ['limit']],
    ['limit text', { ...base, limit: 'many' }, ['limit']],
    ['cursor empty', { ...base, cursor: '' }, ['cursor']],
    ['unknown parameter', { ...base, color: 'red' }, ['color']],
    ['repeated parameter', { ...base, lat: ['52.5', '52.6'] }, ['lat']],
  ])('refuses %s and names the field', (_name, query, fields) => {
    expect(parseNearQuery(query)).toEqual({ ok: false, fields });
  });

  it.each([
    ['smallest radius', { radiusKm: '0.1' }],
    ['largest radius', { radiusKm: '50' }],
    ['limit 1', { limit: '1' }],
    ['limit 50', { limit: '50' }],
    ['the south pole', { lat: '-90', lng: '0' }],
    ['the antimeridian', { lat: '0', lng: '-180' }],
  ])('accepts %s', (_name, extra) => {
    expect(parseNearQuery({ ...base, ...extra }).ok).toBe(true);
  });
});

describe('S19 AS-42 browse query', () => {
  const id = '0190c6a0-0000-7000-8000-000000000001';

  it('takes productId and refuses q', () => {
    expect(parseBrowseQuery({ ...base, productId: id })).toMatchObject({
      ok: true,
      value: { productId: id, radiusKm: 5, limit: 20 },
    });
    expect(parseBrowseQuery({ ...base, q: 'x' })).toEqual({
      ok: false,
      fields: ['q'],
    });
  });

  it('refuses a productId that is not a UUID', () => {
    expect(parseBrowseQuery({ ...base, productId: 'abc' })).toEqual({
      ok: false,
      fields: ['productId'],
    });
  });
});

describe('S19 AS-37 cluster query', () => {
  it('reads the box in the order top, left, bottom, right and defaults the zoom', () => {
    expect(parseClusterQuery({ bbox: '52.7,13.1,52.3,13.7' })).toEqual({
      ok: true,
      value: {
        bbox: { top: 52.7, left: 13.1, bottom: 52.3, right: 13.7 },
        zoom: 10,
      },
    });
  });

  it('accepts a box that crosses the antimeridian', () => {
    const result = parseClusterQuery({ bbox: '10,170,-10,-170' });
    expect(result.ok && result.value.bbox.left).toBe(170);
  });

  it.each([
    ['missing', {}, ['bbox']],
    ['three numbers', { bbox: '1,2,3' }, ['bbox']],
    ['five numbers', { bbox: '1,2,3,4,5' }, ['bbox']],
    ['text', { bbox: 'a,b,c,d' }, ['bbox']],
    ['latitude above 90', { bbox: '91,0,0,1' }, ['bbox']],
    ['latitude below -90', { bbox: '10,0,-91,1' }, ['bbox']],
    ['longitude above 180', { bbox: '10,0,0,181' }, ['bbox']],
    ['longitude below -180', { bbox: '10,-181,0,1' }, ['bbox']],
    ['top equal to bottom', { bbox: '10,0,10,1' }, ['bbox']],
    ['top below bottom', { bbox: '0,0,10,1' }, ['bbox']],
  ])('refuses a box that is %s', (_name, query, fields) => {
    expect(parseClusterQuery(query)).toEqual({ ok: false, fields });
  });

  it.each(['-1', '21', '2.5', 'high', ''])('refuses zoom %p', (zoom) => {
    expect(parseClusterQuery({ bbox: '1,0,0,1', zoom })).toEqual({
      ok: false,
      fields: ['zoom'],
    });
  });

  it.each(['0', '10', '20'])('accepts zoom %s', (zoom) => {
    expect(parseClusterQuery({ bbox: '1,0,0,1', zoom }).ok).toBe(true);
  });
});

describe('seller list query', () => {
  it('defaults the limit and refuses unknown parameters', () => {
    expect(parseListQuery({})).toEqual({ ok: true, value: { limit: 20 } });
    expect(parseListQuery({ page: '2' })).toEqual({
      ok: false,
      fields: ['page'],
    });
  });
});
