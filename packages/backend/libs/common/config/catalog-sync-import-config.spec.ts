import { importProductionRule } from './catalog-sync-config';

const base = {
  clamav_host: 'clamav:3310',
  usercontent_origin: 'https://files.example.com',
};
const run = (values: Record<string, unknown>, production = true) =>
  importProductionRule({ get: (k) => values[k], production });

describe('S07 import production rule (AS-32)', () => {
  it('S07 AS-32: production with a scanner and a user-content origin passes', () => {
    expect(run(base)).toEqual([]);
  });

  it('S07 AS-32: production without a scanner address fails naming the setting', () => {
    expect(run({ ...base, clamav_host: undefined })).toEqual([
      expect.stringContaining('clamav_host'),
    ]);
    expect(run({ ...base, clamav_host: '' })).toEqual([
      expect.stringContaining('clamav_host'),
    ]);
  });

  it('S07 AS-32: production cannot disable the scanner', () => {
    expect(run({ ...base, media_scanner_disabled: true })).toEqual([
      expect.stringContaining('media_scanner_disabled'),
    ]);
  });

  it('S07 AS-29: production needs the user-content origin for the report links', () => {
    expect(run({ ...base, usercontent_origin: undefined })).toEqual([
      expect.stringContaining('usercontent_origin'),
    ]);
  });

  it('S07 AS-32: outside production nothing is required and the scanner may be disabled', () => {
    expect(run({}, false)).toEqual([]);
    expect(run({ media_scanner_disabled: true }, false)).toEqual([]);
  });

  it('S07 AS-32: the messages never contain a value', () => {
    const messages = run({
      clamav_host: undefined,
      media_scanner_disabled: true,
      usercontent_origin: undefined,
    });
    expect(messages).toHaveLength(3);
    expect(messages.join(' ')).not.toContain('https://');
  });
});
