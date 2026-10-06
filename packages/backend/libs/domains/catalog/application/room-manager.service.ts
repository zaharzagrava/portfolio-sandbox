import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle/shutdown-registry.service';
import { DraftStore } from '../infra/draft-store';
import { Room } from './room';

export const COLLAB_REVOKE_CHANNEL = 'collab:revoke';
const IDLE_UNLOAD_MS = 30_000;

/**
 * Rooms on this instance: single-flight loading (50 editors opening a draft at
 * once load it once), idle unload 30 s after the last editor leaves (flush +
 * compaction), and access revocation over Redis pub/sub - a demoted staff
 * member is kicked from whichever instance holds the room.
 */
@Injectable()
export class RoomManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomManager.name);
  private readonly rooms = new Map<string, Promise<Room>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly subscriber: Redis;

  constructor(
    private readonly store: DraftStore,
    config: ApiConfigService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    this.subscriber = new Redis(config.get('redis_url'), { maxRetriesPerRequest: null, lazyConnect: true });
    shutdown?.register({ name: 'collab.rooms.close', order: 15, run: () => this.onModuleDestroy() });
  }

  async onModuleInit() {
    await this.subscriber.connect().catch((e) => this.logger.warn(`revoke channel unavailable: ${e.message}`));
    await this.subscriber.subscribe(COLLAB_REVOKE_CHANNEL).catch(() => undefined);
    this.subscriber.on('message', (_channel: string, raw: string) => {
      const { draftId, userId } = JSON.parse(raw) as { draftId: string; userId: string };
      void this.rooms.get(draftId)?.then((room) => room.kick(userId));
    });
  }

  async acquire(draftId: string): Promise<Room> {
    clearTimeout(this.idleTimers.get(draftId));
    this.idleTimers.delete(draftId);
    let room = this.rooms.get(draftId);
    if (!room) {
      room = this.store.load(draftId).then(({ doc, seq }) => new Room(draftId, doc, seq, this.store, (failed) => this.evict(failed)));
      room.catch(() => this.rooms.delete(draftId));
      this.rooms.set(draftId, room);
    }
    return room;
  }

  release(room: Room) {
    if (room.members.size > 0) return;
    this.idleTimers.set(
      room.draftId,
      setTimeout(() => void this.unload(room.draftId), IDLE_UNLOAD_MS),
    );
  }

  count(): number {
    return this.rooms.size;
  }

  private evict(room: Room) {
    this.rooms.delete(room.draftId);
  }

  private async unload(draftId: string) {
    const room = await this.rooms.get(draftId);
    this.rooms.delete(draftId);
    this.idleTimers.delete(draftId);
    await room?.close().catch((e: Error) => this.logger.error(`unload ${draftId}: ${e.message}`));
  }

  async onModuleDestroy() {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    await Promise.all([...this.rooms.keys()].map((id) => this.unload(id)));
    this.subscriber.disconnect();
  }
}
