import { Inject, Injectable, Logger } from '@nestjs/common';
import { chatPushFailedCounter, type PushKind } from '../domain/chat-metrics';
import { PORTS, type LiveBusPort } from '../domain/ports';
import { CHAT_SETTINGS } from '../domain/chat-settings.token';
import type { ChatSettings } from '../domain/config';

/**
 * Best-effort live pushes after a commit (FR-050): a bus that is down or slow never fails or delays the request; the
 * failure is counted by kind (`chat_push_failed_total`) and logged by ids only.
 */
@Injectable()
export class ChatPublisher {
  private readonly log = new Logger(ChatPublisher.name);

  constructor(
    @Inject(PORTS.LiveBusPort) private readonly bus: LiveBusPort,
    @Inject(CHAT_SETTINGS) private readonly settings: ChatSettings,
  ) {}

  channel(
    channelId: string,
    event: Record<string, unknown>,
    kind: PushKind,
  ): Promise<void> {
    return this.guard(
      () => this.bus.publishChannel(channelId, event),
      kind,
      channelId,
    );
  }

  moderation(event: Record<string, unknown>): Promise<void> {
    return this.guard(
      () => this.bus.publishModeration(event),
      'moderation',
      typeof event.channelId === 'string' ? event.channelId : '',
    );
  }

  private async guard(
    fn: () => Promise<void>,
    kind: PushKind,
    channelId: string,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('live bus publish timed out')),
            this.settings.pushTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      chatPushFailedCounter.add(1, { kind });
      this.log.warn(
        `live push failed kind=${kind} channelId=${channelId} reason=${(error as Error).message}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
