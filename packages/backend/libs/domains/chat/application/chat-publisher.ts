import { Inject, Injectable, Logger } from '@nestjs/common';
import { chatPushFailedCounter, type PushKind } from '../domain/chat-metrics';
import { PORTS, type LiveBusPort, type RealtimeHub } from '../domain/ports';
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
    @Inject(PORTS.RealtimeHub) private readonly hub: RealtimeHub,
    @Inject(CHAT_SETTINGS) private readonly settings: ChatSettings,
  ) {}

  async channel(
    channelId: string,
    event: Record<string, unknown>,
    kind: PushKind,
  ): Promise<void> {
    await this.guard(
      () => this.bus.publishChannel(channelId, event),
      kind,
      channelId,
    );
    await this.hint(channelId, event, kind);
  }

  /**
   * The same write as a hint on the web hub topic `chat:<id>` (W05 B-2): ids only, live only; the browser answers it
   * with a sync. The hub adapter never throws; a refusal is counted like any other failed push.
   */
  private async hint(
    channelId: string,
    event: Record<string, unknown>,
    kind: PushKind,
  ): Promise<void> {
    let data: Record<string, unknown>;
    switch (kind) {
      case 'message': {
        const message = event.message as { id: string; seq: number };
        data = { channelId, messageId: message.id, seq: message.seq };
        break;
      }
      case 'message_deleted':
        data = { channelId, messageId: event.messageId };
        break;
      case 'channel_archived':
        data = { channelId };
        break;
      default:
        return;
    }
    if (!(await this.hub.publish(channelId, kind, data))) {
      chatPushFailedCounter.add(1, { kind });
    }
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
