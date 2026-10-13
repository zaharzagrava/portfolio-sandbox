import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import type { PasswordResetMailer } from '@app/domains/identity';
import { typeDef } from '../domain/catalog';
import { render } from '../domain/templates';
import { DeliveryMessage } from '../domain/types';
import { TRANSACTIONAL_MAIL_CHAIN, type ProviderChain } from '../domain/ports';

/**
 * One-off account mails that must not wait for a queue or depend on preferences (password reset). They go straight
 * through the e-mail failover chain; nothing is persisted, so a token in the link exists only in the mail itself
 * (FR-014). The text, the subject and the link come from the catalog type `security.password_reset` (mandatory,
 * e-mail only, no inbox): the link is the front base plus the catalog path with the token in the fragment, so it
 * reaches no server log or `Referer`.
 */
@Injectable()
export class TransactionalMailService implements PasswordResetMailer {
  private readonly frontBase: string;

  constructor(
    config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TRANSACTIONAL_MAIL_CHAIN) private readonly sender: ProviderChain,
  ) {
    this.frontBase = config.get('front_host').replace(/\/+$/, '');
  }

  async sendResetLink(input: {
    to: string;
    link: string;
    expiresAt: Date;
  }): Promise<void> {
    const token = tokenOf(input.link);
    if (!token) throw new Error('reset link carries no token');
    const minutes = Math.max(
      1,
      Math.round((input.expiresAt.getTime() - this.clock.nowMs()) / 60_000),
    );
    const rendered = render(
      'security.password_reset',
      'en',
      { token, minutes: String(minutes) },
      this.frontBase,
    );
    const def = typeDef('security.password_reset');
    const message: DeliveryMessage = {
      deliveryId: randomUUID(),
      userId: '',
      type: 'auth.password_reset',
      channel: 'email',
      priority: def.priority,
      to: [input.to],
      subject: rendered.emailSubject,
      html: rendered.emailHtml,
      title: rendered.title,
      body: rendered.body,
      link: rendered.link,
    };
    await this.sender.send(message);
  }
}

/** The token is the fragment's `token` parameter; anything else in the caller's link is ignored. */
function tokenOf(link: string): string | null {
  try {
    return new URLSearchParams(new URL(link).hash.slice(1)).get('token');
  } catch {
    return null;
  }
}
