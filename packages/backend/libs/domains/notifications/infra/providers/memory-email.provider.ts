import { randomUUID } from 'node:crypto';
import { DeliveryMessage } from '../../domain/types';
import { ChannelProvider, SendResult } from '../../domain/provider-ports';

export interface MailboxMessage {
  to: string;
  subject: string;
  text: string;
  links: string[];
}

const MAX_MESSAGES = 50;
const URL_PATTERN = /https?:\/\/[^\s"'<>)]+/g;

const unescapeHtml = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** Every http(s) address in the mail, in order, without duplicates. */
export function linksOf(...parts: string[]): string[] {
  const found = new Set<string>();
  for (const part of parts)
    for (const match of unescapeHtml(part).match(URL_PATTERN) ?? [])
      found.add(match);
  return [...found];
}

/**
 * The last 50 mails this process "sent", newest first. One instance per process on purpose: the worker's queue path and
 * the direct transactional path both write here, and the dev mailbox endpoint reads it.
 */
export class MemoryMailbox {
  private readonly messages: MailboxMessage[] = [];

  add(message: MailboxMessage): void {
    this.messages.unshift(message);
    if (this.messages.length > MAX_MESSAGES)
      this.messages.length = MAX_MESSAGES;
  }

  list(to?: string): MailboxMessage[] {
    const wanted = to?.trim().toLowerCase();
    return this.messages
      .filter((m) => !wanted || m.to.toLowerCase() === wanted)
      .map((m) => ({ ...m, links: [...m.links] }));
  }

  clear(): void {
    this.messages.length = 0;
  }
}

export const memoryMailbox = new MemoryMailbox();

/** `EMAIL_PROVIDER=memory`: no network, the mail lands in `memoryMailbox`. Dev and test only. */
export class MemoryEmailProvider extends ChannelProvider {
  readonly name = 'memory';
  readonly channel = 'email' as const;

  send(message: DeliveryMessage): Promise<SendResult> {
    for (const to of message.to)
      memoryMailbox.add({
        to,
        subject: message.subject,
        text: message.body,
        links: linksOf(message.html, message.body, message.link),
      });
    return Promise.resolve({
      provider: this.name,
      providerMessageId: randomUUID(),
    });
  }
}
