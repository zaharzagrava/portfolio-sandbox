import { Inject, Injectable, Optional } from '@nestjs/common';
import { Clock, CLOCK } from '@app/common/core/clock';
import {
  safeRequest,
  SafeRequestError,
  type SafeRequestErrorKind,
  type SafeRequestOptions,
} from '@app/infrastructure/net';
import {
  AttemptError,
  OutboundHttp,
  OutboundRequest,
  OutboundResult,
} from '../domain/webhook-ports';
import {
  WEBHOOK_SETTINGS,
  type WebhookSettings,
} from './webhook-settings.provider';

/**
 * Test seams of the outbound call: the resolver answering host names, the CA that signs a stand-in receiver and the map
 * from a checked address to the stand-in's port (S54 `safeRequest` options). Absent in production; the S54 client refuses
 * every one of them when `NODE_ENV=production`.
 */
export const WEBHOOK_NET_OPTIONS = Symbol('WEBHOOK_NET_OPTIONS');
export type WebhookNetOptions = Pick<
  SafeRequestOptions,
  'resolver' | 'testTransport' | 'allowHttpHosts'
>;

/**
 * What the local profile's `allowedReceiverHosts` (`host:port`) adds to the S54 options: the host may be private, may use
 * its port and may present a self-signed certificate. Empty in production, where startup refuses the setting.
 */
export function receiverAllowances(settings: WebhookSettings) {
  const hosts = settings.allowedReceiverHosts.map((entry) =>
    entry.slice(0, entry.lastIndexOf(':')),
  );
  const ports = settings.allowedReceiverHosts.map((entry) =>
    Number(entry.slice(entry.lastIndexOf(':') + 1)),
  );
  return {
    allowPrivateHosts: [...settings.privateHostAllowance, ...hosts],
    allowSelfSignedHosts: hosts,
    allowedPorts: [443, ...ports],
  };
}

/** The one place that knows S54's failure vocabulary (a renamed kind changes only this table). */
const ERROR_OF: Record<SafeRequestErrorKind, AttemptError> = {
  blocked_address: 'blocked_address',
  unresolvable: 'unresolvable',
  invalid_url: 'invalid_url',
  redirect_refused: 'redirect_refused',
  redirected_host: 'redirected_host',
  too_many_redirects: 'too_many_redirects',
  unsupported_content_type: 'unsupported_content_type',
  timeout: 'timeout',
  tls_error: 'tls_error',
  network_error: 'network_error',
};

/** Seconds from a `Retry-After` header (delta-seconds or an HTTP date); undefined when absent or unusable. */
export function parseRetryAfter(
  value: string | string[] | undefined,
  now: Date,
): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed);
  if (!/^[A-Za-z]{3},/.test(trimmed)) return undefined; // an HTTP date starts with the day name; "-5" is not one
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/**
 * Outbound POST through S54 `safeRequest` (S43 R-08, FR-031, FR-040): resolution, public-address check and pinning on
 * every attempt, one overall deadline, a capped read of the answer, no redirect followed (a `3xx` is returned as a result
 * and counts as a failure for the caller). A receiver or network problem is a typed result, never an exception; a
 * programmer or configuration error (a transaction open around the call, an escape hatch in production) still throws.
 */
@Injectable()
export class SafeOutboundHttpAdapter extends OutboundHttp {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WEBHOOK_SETTINGS) private readonly settings: WebhookSettings,
    @Optional()
    @Inject(WEBHOOK_NET_OPTIONS)
    private readonly net: WebhookNetOptions = {},
  ) {
    super();
  }

  async post(request: OutboundRequest): Promise<OutboundResult> {
    const started = this.clock.now().getTime();
    try {
      const result = await safeRequest({
        method: 'POST',
        url: request.url,
        headers: request.headers,
        body: request.body,
        timeoutMs: request.timeoutMs,
        maxResponseBytes: request.maxResponseBytes,
        followRedirects: false,
        ...receiverAllowances(this.settings),
        clock: this.clock,
        ...this.net,
      });
      return {
        kind: 'response',
        status: result.status,
        snippet: result.snippet,
        retryAfterSec: parseRetryAfter(
          result.headers['retry-after'],
          this.clock.now(),
        ),
        durationMs: result.durationMs,
      };
    } catch (error) {
      if (error instanceof SafeRequestError)
        return {
          kind: 'failure',
          error: ERROR_OF[error.kind],
          durationMs: this.clock.now().getTime() - started,
        };
      throw error;
    }
  }
}
