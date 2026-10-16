import { ASSET_DEFAULTS, resolveAssetConfig } from './asset-config';

describe('S31 asset library configuration', () => {
  it('takes the documented defaults when nothing is set', () => {
    expect(resolveAssetConfig({})).toEqual(ASSET_DEFAULTS);
    expect(ASSET_DEFAULTS).toEqual({
      quotaBytes: 100 * 1024 ** 3,
      versionCap: 500,
      undeleteDays: 30,
      journalDays: 90,
      gcGraceHours: 24,
    });
  });

  it('reads numeric strings from the environment', () => {
    expect(
      resolveAssetConfig({
        assets_quota_bytes: '1048576',
        assets_gc_grace_hours: '2',
      }),
    ).toMatchObject({ quotaBytes: 1_048_576, gcGraceHours: 2 });
  });

  it.each([['0'], ['-5'], ['1.5'], ['lots'], ['']])(
    'refuses %j and names the key, never the value',
    (value) => {
      expect(() => resolveAssetConfig({ assets_version_cap: value })).toThrow(
        /assets_version_cap/,
      );
      try {
        resolveAssetConfig({ assets_version_cap: value });
      } catch (error) {
        if (value) expect((error as Error).message).not.toContain(value);
      }
    },
  );
});
