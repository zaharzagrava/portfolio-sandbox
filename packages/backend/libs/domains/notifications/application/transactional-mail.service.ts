import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import type { PasswordResetMailer } from '@app/domains/identity';
import { DeliveryMessage } from '../domain/types';
import { escapeHtml } from '../domain/templates';
import { emailProviderChain } from '../infra/notification-providers';
import { ChannelSender } from '../infra/providers/channel-sender';

/**
 * One-off account mails that must not wait for a queue or depend on preferences (password reset). They go straight
 * through the e-mail failover chain; nothing is persisted, so a token in the link exists only in the mail itself.
 */
@Injectable()
export class TransactionalMailService implements PasswordResetMailer {
  private readonly sender: ChannelSender;

  constructor(config: ApiConfigService) {
    this.sender = new ChannelSender(emailProviderChain(config));
  }

  async sendResetLink(input: {
    to: string;
    link: string;
    expiresAt: Date;
  }): Promise<void> {
    const minutes = Math.max(
      1,
      Math.round((input.expiresAt.getTime() - Date.now()) / 60_000),
    );
    const body = `Use this link to choose a new password: ${input.link}\nIt works once and expires in about ${minutes} minutes. If you did not ask for it, ignore this message.`;
    const message: DeliveryMessage = {
      deliveryId: randomUUID(),
      userId: '',
      type: 'auth.password_reset',
      channel: 'email',
      priority: 'transactional',
      to: [input.to],
      subject: 'Reset your password',
      html: `<p>Use this link to choose a new password:</p><p><a href="${escapeHtml(input.link)}">Reset password</a></p><p>It works once and expires in about ${minutes} minutes. If you did not ask for it, ignore this message.</p>`,
      title: 'Reset your password',
      body,
      link: input.link,
    };
    await this.sender.send(message);
  }
}
