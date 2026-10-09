import { ApiConfigService } from '@app/common/config/api-config.service';
import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';

/** The real test configuration with some keys overridden (e.g. `node_env: 'production'`); bind with `overrideProvider(ApiConfigService)`. */
export async function configWith(
  overrides: Record<string, unknown>,
): Promise<ApiConfigService> {
  const real = new ApiConfigService(new ConfigUtilsService());
  await real.init();
  return {
    get: (key: string) =>
      key in overrides ? overrides[key] : real.get(key as never),
  } as unknown as ApiConfigService;
}
