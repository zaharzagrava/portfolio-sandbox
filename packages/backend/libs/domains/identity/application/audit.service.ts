import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RequestContext } from '@app/infrastructure/context';

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
const events = MetricsRegistry.counter({
  name: 'auth_events_total',
  help: 'Security events of the identity domain by endpoint, result and bounded reason',
  labels: ['endpoint', 'result', 'reason'],
});

const mfaVerify = MetricsRegistry.counter({
  name: 'auth_mfa_verify_total',
  help: 'Second-factor code checks at login by result and kind of code',
  labels: ['result', 'method'],
});
const challengeBurned = MetricsRegistry.counter({
  name: 'auth_mfa_challenge_burned_total',
  help: 'Login challenges used up by wrong codes',
  labels: [],
});
const accountLink = MetricsRegistry.counter({
  name: 'auth_account_link_total',
  help: 'Provider identities linked to an account by how',
  labels: ['method'],
});
const accountLinkWipe = MetricsRegistry.counter({
  name: 'auth_account_link_wipe_total',
  help: 'Password accounts taken over by a provider link (password, factor and sessions removed)',
  labels: [],
});

/** Every audited event with the bounded labels it is counted under (FR-095). */
const EVENTS = {
  'auth.login.failed': {
    endpoint: 'login',
    result: 'failure',
    reason: 'invalid_credentials',
  },
  'auth.login.succeeded': {
    endpoint: 'login',
    result: 'success',
    reason: 'ok',
  },
  'auth.session.created': {
    endpoint: 'session',
    result: 'success',
    reason: 'created',
  },
  'auth.session.revoked': {
    endpoint: 'session',
    result: 'success',
    reason: 'revoked',
  },
  'auth.refresh.reuse_detected': {
    endpoint: 'refresh',
    result: 'failure',
    reason: 'reuse',
  },
  'auth.registration.duplicate_attempted': {
    endpoint: 'register',
    result: 'failure',
    reason: 'duplicate',
  },
  'auth.password_reset.requested': {
    endpoint: 'reset',
    result: 'success',
    reason: 'requested',
  },
  'auth.password_reset.completed': {
    endpoint: 'reset',
    result: 'success',
    reason: 'completed',
  },
  'auth.signing_key.rotated': {
    endpoint: 'signing_key',
    result: 'success',
    reason: 'rotated',
  },
  'auth.signing_key.purged': {
    endpoint: 'signing_key',
    result: 'success',
    reason: 'purged',
  },
  'auth.mfa.enrolled': {
    endpoint: 'mfa',
    result: 'success',
    reason: 'enrolled',
  },
  'auth.mfa.confirmed': {
    endpoint: 'mfa',
    result: 'success',
    reason: 'confirmed',
  },
  'auth.mfa.failed': {
    endpoint: 'mfa',
    result: 'failure',
    reason: 'wrong_code',
  },
  'auth.mfa.verified': {
    endpoint: 'mfa',
    result: 'success',
    reason: 'verified',
  },
  'auth.mfa.recovery_used': {
    endpoint: 'mfa',
    result: 'success',
    reason: 'recovery_used',
  },
  'auth.mfa.regenerated': {
    endpoint: 'mfa',
    result: 'success',
    reason: 'regenerated',
  },
  'auth.mfa.disabled': {
    endpoint: 'mfa',
    result: 'success',
    reason: 'disabled',
  },
  'auth.mfa.challenge_burned': {
    endpoint: 'mfa',
    result: 'failure',
    reason: 'challenge_burned',
  },
  'auth.oidc.started': {
    endpoint: 'oidc',
    result: 'success',
    reason: 'started',
  },
  'auth.oidc.callback_failed': {
    endpoint: 'oidc',
    result: 'failure',
    reason: 'callback_failed',
  },
  'auth.oidc.login': { endpoint: 'oidc', result: 'success', reason: 'login' },
  'auth.oidc.linked': { endpoint: 'oidc', result: 'success', reason: 'linked' },
  'auth.oidc.unlinked': {
    endpoint: 'oidc',
    result: 'success',
    reason: 'unlinked',
  },
} as const;

export type AuditEvent = keyof typeof EVENTS;

/** Revocation reasons that become a metric label; anything else is "other" (callers in other domains pass their own). */
const REVOCATION_REASONS = new Set([
  'logout',
  'logout_all',
  'revoked',
  'refresh_token_reuse',
  'password_reset',
  'session_limit',
  'user_deleted',
  'shop_membership_removed',
]);

/**
 * Audit lines for security events (VIII.1): structured, one per event, with the request ID and the ids that are known;
 * never a password, token, hash or address in clear. An address that matched no account is logged as a keyed hash so a
 * spike is debuggable without storing the person's data.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(
    private readonly config: ApiConfigService,
    private readonly context: RequestContext,
  ) {}

  record(event: AuditEvent, fields: Record<string, string | undefined> = {}) {
    const requestId = this.context.requestId;
    this.logger.log({
      event,
      ...(requestId && { requestId }),
      ...Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      ),
    });
    const labels = { ...EVENTS[event] } as {
      endpoint: string;
      result: string;
      reason: string;
    };
    if (event === 'auth.session.revoked' && fields.reason)
      labels.reason = REVOCATION_REASONS.has(fields.reason)
        ? fields.reason
        : 'other';
    events.add(1, labels);
    if (event === 'auth.refresh.reuse_detected') refreshReuse.add(1);
  }

  mfaVerified(result: 'success' | 'failure', method: 'totp' | 'recovery') {
    mfaVerify.add(1, { result, method });
  }

  mfaChallengeBurned(fields: Record<string, string | undefined>) {
    challengeBurned.add(1);
    this.record('auth.mfa.challenge_burned', fields);
  }

  accountLinked(method: 'login' | 'email_match' | 'explicit', wiped = false) {
    accountLink.add(1, { method });
    if (wiped) accountLinkWipe.add(1);
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
