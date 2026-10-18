import type { Provider } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import {
  resolveWebhookSettings,
  WEBHOOK_SETTINGS,
  type WebhookSettings,
} from '../domain/webhook-settings';

export { WEBHOOK_SETTINGS };
export type { WebhookSettings };

/**
 * The validated webhook numbers (S43 FR-032, FR-041, AS-71). The factory runs when the hosting module boots, so a
 * private-host allowance in production, a falling retry schedule, a jitter outside 0..0.5 or a non-positive timeout
 * stops the process at startup with a message naming the setting.
 */
export const webhookSettingsProvider: Provider = {
  provide: WEBHOOK_SETTINGS,
  inject: [ApiConfigService],
  useFactory: (config: ApiConfigService): WebhookSettings =>
    resolveWebhookSettings(
      {
        privateHostAllowance: config.get('webhooks_allow_private_hosts'),
        allowedReceiverHosts: config.get('allowed_receiver_hosts'),
        attemptTimeoutMs: config.get('webhooks_attempt_timeout_ms'),
        workerConcurrency: config.get('webhooks_worker_concurrency'),
        visibilityTimeoutSec: config.get('webhooks_visibility_timeout_sec'),
        retryDelaysMinutes: config.get('webhooks_retry_delays_minutes'),
        jitter: config.get('webhooks_jitter'),
      },
      { nodeEnv: config.get('node_env') },
    ),
};
