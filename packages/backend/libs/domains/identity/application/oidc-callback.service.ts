import { Inject, Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  OIDC_FLOW_STORE,
  OIDC_PROVIDER,
  OidcProviderError,
  type OidcFlowStore,
  type OidcProviderPort,
  type SessionMeta,
} from '../domain/ports';
import { readIdTokenClaims } from '../domain/id-token-claims';
import {
  OidcCallbackError,
  type OidcCallbackErrorCode,
} from '../domain/oidc-errors';
import { ApiConfigService } from '@app/common/config';
import { redirectUriFor, sha256Hex } from './oidc-flow.service';
import { OidcLoginService } from './oidc-login.service';
import { OidcProviderRegistry } from './oidc-provider-registry';
import { SecondFactorService } from './second-factor.service';
import { IssuedSession, SessionIssuer } from './session-issuer.service';

const loginTotal = MetricsRegistry.counter({
  name: 'auth_oidc_login_total',
  help: 'Provider sign-in callbacks by provider and result',
  labels: ['provider', 'result'],
});
const providerTimeouts = MetricsRegistry.counter({
  name: 'auth_oidc_provider_timeout_total',
  help: 'Provider requests that exceeded their deadline',
  labels: [],
});

export type CallbackResult =
  | { kind: 'session'; issued: IssuedSession; returnPath: string }
  | { kind: 'linked'; returnPath: string }
  | { kind: 'failure'; code: OidcCallbackErrorCode };

export interface CallbackInput {
  provider: string;
  /** Raw query values: a repeated parameter arrives as an array. */
  query: { state?: unknown; code?: unknown; error?: unknown };
  flowCookie: string | undefined;
  meta: SessionMeta;
}

const resultLabel: Record<OidcCallbackErrorCode, string> = {
  oidc_state_invalid: 'state_invalid',
  oidc_denied: 'denied',
  oidc_exchange_failed: 'exchange_failed',
  oidc_token_invalid: 'token_invalid',
  oidc_provider_unavailable: 'provider_unavailable',
  email_not_verified: 'email_not_verified',
  account_unavailable: 'account_unavailable',
  link_conflict: 'link_conflict',
  identity_already_linked: 'identity_already_linked',
};

const safeEqual = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The callback, in the order of FR-043: consume the flow → cookie binding → provider match → provider error →
 * exactly one code → exchange (verifies the ID token) → claims → who is this (`OidcLoginService`) → session after the
 * commit. Every outcome is a value: a failure is a closed code, never an exception to the filter, and provider text
 * is never copied anywhere.
 */
@Injectable()
export class OidcCallbackService {
  private readonly logger = new Logger(OidcCallbackService.name);

  constructor(
    @Inject(OIDC_FLOW_STORE) private readonly store: OidcFlowStore,
    @Inject(OIDC_PROVIDER) private readonly provider: OidcProviderPort,
    private readonly registry: OidcProviderRegistry,
    private readonly login: OidcLoginService,
    private readonly factor: SecondFactorService,
    private readonly issuer: SessionIssuer,
    private readonly config: ApiConfigService,
  ) {}

  async handle(input: CallbackInput): Promise<CallbackResult> {
    const label = input.provider === 'google' ? 'google' : 'shop';
    try {
      const result = await this.run(input);
      loginTotal.add(1, { provider: label, result: 'success' });
      return result;
    } catch (error) {
      if (error instanceof OidcCallbackError) {
        loginTotal.add(1, { provider: label, result: resultLabel[error.code] });
        return { kind: 'failure', code: error.code };
      }
      // A browser navigation cannot show a problem document: an unexpected fault is a failed sign-in with a closed code.
      this.logger.error(`oidc callback failed: ${(error as Error)?.name}`);
      loginTotal.add(1, { provider: label, result: 'exchange_failed' });
      return { kind: 'failure', code: 'oidc_exchange_failed' };
    }
  }

  private async run(input: CallbackInput): Promise<CallbackResult> {
    const { state, code, error } = input.query;
    if (typeof state !== 'string' || state.length === 0 || state.length > 256)
      throw new OidcCallbackError('oidc_state_invalid');

    // The flow is spent by looking at it, whatever happens next.
    const flow = await this.store.consume(sha256Hex(state));
    if (!flow) throw new OidcCallbackError('oidc_state_invalid');
    if (
      !input.flowCookie ||
      !safeEqual(sha256Hex(input.flowCookie), flow.cookieDigest)
    )
      throw new OidcCallbackError('oidc_state_invalid');
    if (flow.provider !== input.provider)
      throw new OidcCallbackError('oidc_state_invalid');

    if (error !== undefined) throw new OidcCallbackError('oidc_denied');
    if (typeof code !== 'string' || code.length === 0 || code.length > 2048)
      throw new OidcCallbackError('oidc_exchange_failed');

    const resolved = await this.registry.resolve(flow.provider);
    if (!resolved) throw new OidcCallbackError('oidc_provider_unavailable');

    let claims: Record<string, unknown>;
    try {
      claims = await this.provider.exchange(resolved.id, resolved.settings, {
        code,
        state,
        verifier: flow.verifier,
        nonce: flow.nonce,
        redirectUri: redirectUriFor(this.config, resolved.id),
      });
    } catch (e) {
      if (e instanceof OidcProviderError) {
        if (e.timeout) providerTimeouts.add(1);
        throw new OidcCallbackError(
          e.kind === 'unavailable'
            ? 'oidc_provider_unavailable'
            : e.kind === 'token'
              ? 'oidc_token_invalid'
              : 'oidc_exchange_failed',
        );
      }
      throw new OidcCallbackError('oidc_exchange_failed');
    }

    const read = readIdTokenClaims(claims);
    if (!read.ok) throw new OidcCallbackError('oidc_token_invalid');

    if (flow.purpose === 'link') {
      if (!flow.userId) throw new OidcCallbackError('oidc_state_invalid');
      await this.login.linkExplicit({
        userId: flow.userId,
        provider: resolved.id,
        identity: read.identity,
      });
      return { kind: 'linked', returnPath: flow.returnPath };
    }

    const { userId } = await this.login.complete({
      provider: resolved.id,
      trust: resolved.trust,
      identity: read.identity,
    });
    // The second-factor challenge for federated logins arrives with US7; until then an enabled factor must not be
    // skipped, so such a login ends without a session.
    if (await this.factor.isSecondFactorEnrolled(userId))
      throw new OidcCallbackError('oidc_exchange_failed');

    const issued = await this.issuer.issue({
      userId,
      amr: ['fed'],
      delivery: 'cookie',
      meta: input.meta,
    });
    return { kind: 'session', issued, returnPath: flow.returnPath };
  }
}
