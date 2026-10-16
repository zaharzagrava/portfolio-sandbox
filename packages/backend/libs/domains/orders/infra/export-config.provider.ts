import type { Provider } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import {
  EXPORT_CONFIG,
  validateExportConfig,
  type ExportConfig,
} from '../domain/export-config';

/**
 * Reads the `ORDER_EXPORT_*` settings (defaults in `orders-config.ts`) and refuses to start when one is out of range,
 * naming the key and never a value (S12 FR-038, AS-59). The worker and the API both resolve it before they take work.
 */
export const exportConfigProvider: Provider = {
  provide: EXPORT_CONFIG,
  inject: [ApiConfigService],
  useFactory: (config: ApiConfigService): ExportConfig => {
    const value: ExportConfig = {
      batchSize: config.get('orders_export_batch_size'),
      rowLimit: config.get('orders_export_row_limit'),
      deadlineSec: config.get('orders_export_deadline_seconds'),
      leaseSec: config.get('orders_export_lease_seconds'),
      heartbeatSec: config.get('orders_export_heartbeat_seconds'),
      storageInactivitySec: config.get(
        'orders_export_storage_inactivity_seconds',
      ),
      fileRetentionDays: config.get('orders_export_file_retention_days'),
      recordRetentionDays: config.get('orders_export_record_retention_days'),
      linkTtlSec: config.get('orders_export_link_ttl_seconds'),
      unclaimedSec: config.get('orders_export_unclaimed_seconds'),
      userContentOrigin: config.get('usercontent_origin') ?? null,
    };
    const issues = validateExportConfig(value, {
      production: process.env.NODE_ENV === 'production',
    });
    if (issues.length > 0)
      throw new Error(
        `Config validation error: ${issues.map((i) => i.message).join('; ')}`,
      );
    return value;
  },
};
