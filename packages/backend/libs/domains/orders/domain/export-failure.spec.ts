import {
  classify,
  failureMessage,
  type ExportFailureCode,
} from './export-failure';

const CODES: ExportFailureCode[] = [
  'storage_unavailable',
  'catalog_unavailable',
  'database_unavailable',
  'row_limit_exceeded',
  'timeout',
  'shop_not_found',
  'attempts_exhausted',
  'internal_error',
];

describe('export failure classification', () => {
  it.each([
    ['storage_error', 'storage_unavailable'],
    ['storage_inactivity_timeout', 'storage_unavailable'],
    ['upload_aborted', 'storage_unavailable'],
    ['catalog_timeout', 'catalog_unavailable'],
    ['catalog_error', 'catalog_unavailable'],
    ['order_store_timeout', 'database_unavailable'],
    ['connection_reset', 'database_unavailable'],
    ['deadlock', 'database_unavailable'],
    ['serialization_failure', 'database_unavailable'],
  ])('S12 AS-35: %s retries with %s', (cls, code) => {
    expect(classify(cls, 1)).toEqual({ retry: true, code });
    expect(classify(cls, 2)).toEqual({ retry: true, code });
  });

  it.each([
    ['row_limit_exceeded', 'row_limit_exceeded'],
    ['deadline_exceeded', 'timeout'],
    ['shop_not_found', 'shop_not_found'],
    ['something_else', 'internal_error'],
  ])('S12 AS-35: %s fails now with %s', (cls, code) => {
    expect(classify(cls, 1)).toEqual({ retry: false, code });
  });

  it.each([
    ['storage_error', 'storage_unavailable'],
    ['catalog_timeout', 'catalog_unavailable'],
    ['deadlock', 'database_unavailable'],
  ])(
    'S12 AS-35: third delivery turns %s into a failure with the same code',
    (cls, code) => {
      expect(classify(cls, 3)).toEqual({ retry: false, code });
    },
  );

  it('S12 AS-35: an unknown class is internal_error', () => {
    expect(classify('', 1)).toEqual({ retry: false, code: 'internal_error' });
    expect(classify('constructor', 1)).toEqual({
      retry: false,
      code: 'internal_error',
    });
  });

  it.each(CODES)('S12 AS-35: %s has one fixed generic message', (code) => {
    expect(failureMessage(code)).toMatch(/\S/);
  });

  it('S12 AS-35: storage_unavailable message', () => {
    expect(failureMessage('storage_unavailable')).toBe(
      'The file could not be stored. Start a new export.',
    );
  });
});
