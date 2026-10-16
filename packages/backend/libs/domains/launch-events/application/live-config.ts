import type { ApiConfigService } from '@app/common/config';
import {
  DEFAULT_LIVE_MODERATION_THRESHOLD,
  DEFAULT_LIVE_SAMPLE_SIZE,
  DEFAULT_LIVE_VIEWER_CAP,
  DEFAULT_LIVE_WINDOW_MS,
} from '@app/common/config/launch-events-config';
import type { LiveSettings } from '../domain/live-ports';

/**
 * The live settings (G-24, AS-53). The bounds are enforced by the config schema when the process starts (a value outside
 * them refuses the start and names the setting); an unset value takes the default.
 */
export function readLiveConfig(config: ApiConfigService): LiveSettings {
  return {
    windowMs: config.get('live_window_ms') ?? DEFAULT_LIVE_WINDOW_MS,
    sampleSize: config.get('live_sample_size') ?? DEFAULT_LIVE_SAMPLE_SIZE,
    viewerCap: config.get('live_viewer_cap') ?? DEFAULT_LIVE_VIEWER_CAP,
    moderationThreshold:
      config.get('live_moderation_threshold') ??
      DEFAULT_LIVE_MODERATION_THRESHOLD,
  };
}
