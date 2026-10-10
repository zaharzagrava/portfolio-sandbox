import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

const refreshReuse = MetricsRegistry.counter({
  name: 'auth_refresh_reuse_total',
  help: 'Spent refresh tokens presented again (session revoked)',
  labels: [],
});
const breachSkipped = MetricsRegistry.counter({
  name: 'auth_breach_check_skipped_total',
  help: 'Registrations that proceeded because the breached-password lookup failed or timed out',
  labels: [],
});

export type AuditEvent =
  'auth.refresh.reuse_detected' | 'auth.login.failed' | 'auth.login.succeeded';

/**
 * Audit lines for security events (VIII.1): structured, no password, token, hash or address in clear. An address that
 * matched no account is logged as a keyed hash so a spike is debuggable without storing the person's data.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly config: ApiConfigService) {}

  record(event: AuditEvent, fields: Record<string, string | undefined> = {}) {
    this.logger.log({ event, ...fields });
    if (event === 'auth.refresh.reuse_detected') refreshReuse.add(1);
  }

  breachCheckSkipped(): void {
    breachSkipped.add(1);
  }

  /** Stable, non-reversible tag of an address. */
  tag(value: string): string {
    return createHmac('sha256', this.config.get('jwt_secret'))
      .update(value)
      .digest('base64url')
      .slice(0, 16);
  }
}
