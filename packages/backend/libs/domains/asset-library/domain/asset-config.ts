import { z } from 'zod';

/**
 * The numbers of S31 that an operator may change (spec Assumptions: limits are constants with these defaults). The
 * module resolves them once at start, so a bad value is a startup failure naming every broken key, never a value.
 * `usercontent_origin` is validated by the platform rules (it must differ from the app origin in production).
 */
export const ASSET_DEFAULTS = {
  quotaBytes: 100 * 1024 * 1024 * 1024,
  versionCap: 500,
  undeleteDays: 30,
  journalDays: 90,
  gcGraceHours: 24,
} as const;

export type AssetConfig = { [K in keyof typeof ASSET_DEFAULTS]: number };

const positiveInt = z.number().int().min(1);

const schema = z.object({
  assets_quota_bytes: positiveInt,
  assets_version_cap: positiveInt,
  assets_undelete_days: positiveInt,
  assets_journal_days: positiveInt,
  assets_gc_grace_hours: positiveInt,
});

const KEYS = {
  assets_quota_bytes: 'quotaBytes',
  assets_version_cap: 'versionCap',
  assets_undelete_days: 'undeleteDays',
  assets_journal_days: 'journalDays',
  assets_gc_grace_hours: 'gcGraceHours',
} as const satisfies Record<keyof z.input<typeof schema>, keyof AssetConfig>;

export type AssetConfigKey = keyof typeof KEYS;
export const ASSET_CONFIG_KEYS = Object.keys(KEYS) as AssetConfigKey[];

/** Env values are strings: a numeric string is a number; anything else stays as given and fails validation. */
const asNumber = (value: unknown) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export function resolveAssetConfig(
  raw: Record<string, unknown> = {},
): AssetConfig {
  // Unset (undefined/null) takes the default; an empty string is a value and fails like any other bad one.
  const candidate = Object.fromEntries(
    ASSET_CONFIG_KEYS.map((key) => {
      const value = raw[key];
      return [
        key,
        value === undefined || value === null
          ? ASSET_DEFAULTS[KEYS[key]]
          : asNumber(value),
      ];
    }),
  );
  const parsed = schema.safeParse(candidate);
  if (!parsed.success)
    throw new Error(
      `Invalid asset library configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || 'config'} ${i.message}`)
        .join('; ')}`,
    );
  const out: Record<string, number> = {};
  for (const key of ASSET_CONFIG_KEYS) out[KEYS[key]] = parsed.data[key];
  return out as AssetConfig;
}
