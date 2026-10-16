import { ConfigRules, type RuleCheck } from '@app/common/config';

/**
 * Start-up rule of S31 (FR-033): share and buyer download URLs are built on the user-content origin, so production
 * needs one. That it differs from the application's own origin is the platform rule's (`originsDiffer` in
 * `common/config/config-rules.ts`), checked whenever the key is set.
 */
export const assetsOriginRule: RuleCheck = (ctx) => {
  const origin = ctx.get('usercontent_origin');
  const set = typeof origin === 'string' && origin.trim() !== '';
  return ctx.production && !set
    ? ['usercontent_origin is required for share and buyer downloads']
    : [];
};

ConfigRules.register({
  owner: 'asset-library',
  keys: ['usercontent_origin'],
  validate: assetsOriginRule,
});
