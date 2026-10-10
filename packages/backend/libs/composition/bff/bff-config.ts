import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import {
  BffBudgetSection,
  BffConfig,
  BffSettingsValues,
  bffConfigKeys,
  parseBffSettings,
} from '@app/common/config/bff-config';
import { Environment } from '@app/common/types';

/**
 * The validated BFF settings (S48 FR-051). Built once at startup: a missing or malformed upstream origin, bad session
 * or CSRF keys, or a production setup without trusted documents stop the process, naming the keys (never the values).
 * There is no default upstream address.
 */
@Injectable()
export class BffSettings implements BffSettingsValues {
  readonly upstreamOrigin: string;
  readonly sessionKeys: Buffer[];
  readonly csrfKey: Buffer;
  readonly allowedOrigins: string[];
  readonly localDev: boolean;
  readonly trustedDocuments: boolean;
  readonly introspection: boolean;
  readonly pageDeadlineMs: number;
  readonly budgetsMs: Record<BffBudgetSection, number>;
  readonly graphql: BffSettingsValues['graphql'];
  readonly breaker: BffSettingsValues['breaker'];
  readonly gate: BffSettingsValues['gate'];
  readonly cacheCeilingMs: number;
  readonly session: BffSettingsValues['session'];
  readonly production: boolean;

  constructor(config: ApiConfigService) {
    const raw: Partial<BffConfig> = {};
    for (const key of Object.keys(bffConfigKeys) as (keyof BffConfig)[])
      (raw as Record<string, unknown>)[key] = config.get(key);
    this.production = config.get('node_env') === Environment.production;
    Object.assign(this, parseBffSettings(raw, { production: this.production }));
  }
}
