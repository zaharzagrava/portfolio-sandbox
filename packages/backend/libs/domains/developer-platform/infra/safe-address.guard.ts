import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  ENDPOINT_URL_REJECTION_REASONS,
  type EndpointUrlRejectionReason,
} from '@marketplace-sandbox/contracts';
import { checkSafeUrl, SafeRequestError } from '@app/infrastructure/net';
import { AddressGuard, AddressVerdict } from '../domain/webhook-ports';
import {
  WEBHOOK_NET_OPTIONS,
  type WebhookNetOptions,
} from './safe-outbound-http.adapter';
import {
  WEBHOOK_SETTINGS,
  type WebhookSettings,
} from './webhook-settings.provider';

/**
 * The lookup half of the save-time address check (S43 FR-003, P0507), over the S54 guard: scheme, port and user-info
 * rules, then every address the name resolves to must be public. The vocabulary of S54 (`SafeRequestError.kind`) is
 * mapped to the closed `details.reason` list here and nowhere else.
 */
@Injectable()
export class SafeAddressGuard extends AddressGuard {
  constructor(
    @Inject(WEBHOOK_SETTINGS) private readonly settings: WebhookSettings,
    @Optional()
    @Inject(WEBHOOK_NET_OPTIONS)
    private readonly net: WebhookNetOptions = {},
  ) {
    super();
  }

  async check(url: string): Promise<AddressVerdict> {
    try {
      await checkSafeUrl(url, {
        resolver: this.net.resolver,
        allowPrivateHosts: this.settings.privateHostAllowance,
      });
      return { ok: true };
    } catch (error) {
      if (!(error instanceof SafeRequestError)) throw error;
      const reason: EndpointUrlRejectionReason =
        error.kind === 'invalid_url'
          ? 'not_https'
          : (ENDPOINT_URL_REJECTION_REASONS as readonly string[]).includes(
                error.kind,
              )
            ? (error.kind as EndpointUrlRejectionReason)
            : 'blocked_address';
      return { ok: false, reason };
    }
  }
}
