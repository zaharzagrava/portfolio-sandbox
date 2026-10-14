import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { SecretBox } from '@app/domains/identity';
import type { WidgetIdentifyDto } from '@marketplace-sandbox/contracts';
import { evaluateHandoffClaims } from '../domain/handoff-claims';
import { previousSecretState } from '../domain/site-rules';
import {
  identityTokenInvalid,
  serviceUnavailable,
  siteNotFound,
} from '../domain/widget-errors';
import {
  HandoffVerifier,
  SingleUseStore,
  SingleUseUnavailable,
  WidgetSiteRepository,
  WidgetTokenSigner,
  type WidgetSiteView,
} from '../domain/widget-ports';
import { secretContext } from './widget-sites.service';
import { widgetMetrics } from './widget-metrics';

export const WIDGET_TOKEN_LIFETIME_SEC = 900;
const MARKER_GRACE_SEC = 60;

/**
 * The identity hand-off (FR-018…FR-021): signature first (current secret, then a previous one that is still valid at the
 * injected clock), then the claims policy, then the single-use marker, then the widget token. Every rejection is the same
 * `401 identity_token_invalid`; the reason goes to a metric label and the log, never to the caller. Nothing here reads or
 * writes a marketplace user, session or account (FR-021).
 */
@Injectable()
export class WidgetIdentityService {
  private readonly log = new Logger('Widget');

  constructor(
    private readonly sites: WidgetSiteRepository,
    private readonly box: SecretBox,
    private readonly verifier: HandoffVerifier,
    private readonly markers: SingleUseStore,
    private readonly signer: WidgetTokenSigner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Rows sealed before the context existed (`v1`) open without one until the re-seal job has run. */
  private open(sealed: string, siteId: string): string {
    return sealed.startsWith('v1.')
      ? this.box.open(sealed)
      : this.box.open(sealed, secretContext(siteId));
  }

  private reject(reason: string): never {
    widgetMetrics.identify().add(1, { result: 'invalid' });
    widgetMetrics.identifyInvalidReason().add(1, { reason });
    this.log.warn(`identity token rejected: ${reason}`);
    throw identityTokenInvalid();
  }

  async identify(
    site: WidgetSiteView,
    token: string,
  ): Promise<WidgetIdentifyDto> {
    const secrets = await this.sites.secretsOf(site.id);
    if (!secrets) throw siteNotFound();
    const now = this.clock.now();

    let payload = this.verifier.verify(
      token,
      this.open(secrets.current, site.id),
    );
    if (
      !payload &&
      secrets.previous &&
      previousSecretState(secrets.previousExpiresAt, now) === 'valid'
    )
      payload = this.verifier.verify(
        token,
        this.open(secrets.previous, site.id),
      );
    if (!payload) this.reject('bad_signature');

    const verdict = evaluateHandoffClaims(payload, {
      now,
      publishableKey: site.publishableKey,
    });
    if (!verdict.ok) this.reject(verdict.reason);
    const claims = verdict.claims;

    const nowSec = Math.floor(now.getTime() / 1000);
    const marker = `widget:jti:${site.id}:${createHash('sha256').update(claims.jti).digest('hex')}`;
    let fresh: boolean;
    try {
      fresh = await this.markers.claim(
        marker,
        claims.exp - nowSec + MARKER_GRACE_SEC,
      );
    } catch (error) {
      if (!(error instanceof SingleUseUnavailable)) throw error;
      widgetMetrics.singleUseFallback().add(1, {});
      widgetMetrics.identify().add(1, { result: 'unavailable' });
      this.log.error('single-use store unavailable; exchange refused');
      throw serviceUnavailable();
    }
    if (!fresh) {
      widgetMetrics.identify().add(1, { result: 'replay' });
      this.log.warn('identity token replayed');
      throw identityTokenInvalid();
    }

    const minted = this.signer.sign({
      siteId: site.id,
      shopId: site.shopId,
      externalCustomerId: claims.sub,
      email: claims.email,
      now,
      lifetimeSeconds: WIDGET_TOKEN_LIFETIME_SEC,
    });
    widgetMetrics.identify().add(1, { result: 'ok' });
    return {
      widgetToken: minted.token,
      expiresIn: WIDGET_TOKEN_LIFETIME_SEC,
      customer: { id: claims.sub, email: claims.email },
    };
  }
}
