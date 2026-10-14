import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PresenceResponse } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  chatPresenceUnavailableCounter,
  chatPushFailedCounter,
  chatReceiptsSuppressedCounter,
} from '../domain/chat-metrics';
import { CHAT_SETTINGS } from '../domain/chat-settings.token';
import type { ChatSettings } from '../domain/config';
import { presenceUnavailable } from '../domain/errors';
import {
  PORTS,
  type MembershipRepository,
  type PresenceStore,
  type RealtimeHub,
} from '../domain/ports';

/** Presence (S24 US5): a heartbeat marks the user online for 60 s; only the offline to online transition is announced. */
@Injectable()
export class ChatPresenceService {
  private readonly log = new Logger(ChatPresenceService.name);

  constructor(
    @Inject(PORTS.PresenceStore) private readonly store: PresenceStore,
    @Inject(PORTS.MembershipRepository)
    private readonly members: MembershipRepository,
    @Inject(PORTS.RealtimeHub) private readonly hub: RealtimeHub,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CHAT_SETTINGS) private readonly settings: ChatSettings,
  ) {}

  /**
   * Fail open (FR-037): a store that is down still answers `204`; the failure is counted. The transition is announced to
   * the user's most recently active channels with at most the huge-channel threshold of active members, in parallel,
   * each bounded by the push timeout; a hub that is down never fails the heartbeat.
   */
  async heartbeat(userId: string): Promise<void> {
    const now = this.clock.now();
    let previous: number | null;
    try {
      ({ previous } = await this.store.heartbeat(userId, now));
    } catch (error) {
      chatPresenceUnavailableCounter.add(1);
      this.log.warn(
        `presence store unavailable on heartbeat reason=${(error as Error).message}`,
      );
      return;
    }
    const wasOnline =
      previous !== null && now.getTime() - previous < this.ttlMs();
    if (wasOnline) return;

    const channels = await this.members.recentChannels(
      userId,
      this.settings.presenceBroadcastChannels,
    );
    await Promise.all(
      channels.map(async ({ channelId, activeMemberCount }) => {
        if (activeMemberCount > this.settings.hugeChannelThreshold) {
          chatReceiptsSuppressedCounter.add(1, { kind: 'presence' });
          return;
        }
        const published = await this.withTimeout(
          this.hub.publish(channelId, 'presence', {
            userId,
            online: true,
            ttlSeconds: this.settings.presenceTtlS,
          }),
        );
        if (!published) chatPushFailedCounter.add(1, { kind: 'presence' });
      }),
    );
  }

  /**
   * Truthful only for users who share an active channel with the caller (and the caller): everyone else looks offline,
   * exactly like an offline user. A store that is down is `503 presence_unavailable` (an all-offline answer would be false).
   */
  async query(callerId: string, userIds: string[]): Promise<PresenceResponse> {
    const wanted = [...new Set(userIds.map((id) => id.toLowerCase()))];
    if (wanted.length === 0) return {};
    const visible = new Set(await this.members.coMembers(callerId, wanted));
    visible.add(callerId.toLowerCase());
    const lookup = wanted.filter((id) => visible.has(id));
    let seen: Map<string, number | null>;
    try {
      seen = await this.store.multiGet(lookup);
    } catch (error) {
      chatPresenceUnavailableCounter.add(1);
      this.log.warn(
        `presence store unavailable on query reason=${(error as Error).message}`,
      );
      throw presenceUnavailable();
    }
    const now = this.clock.now().getTime();
    return Object.fromEntries(
      wanted.map((id) => {
        const at = seen.get(id) ?? null;
        return [
          id,
          at !== null && now - at < this.ttlMs()
            ? { online: true, lastSeenAt: at }
            : { online: false, lastSeenAt: null },
        ];
      }),
    );
  }

  private ttlMs(): number {
    return this.settings.presenceTtlS * 1000;
  }

  private withTimeout(work: Promise<boolean>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      work,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.settings.pushTimeoutMs);
      }),
    ]).finally(() => timer && clearTimeout(timer));
  }
}
