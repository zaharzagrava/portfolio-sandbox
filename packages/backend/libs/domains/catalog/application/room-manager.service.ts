import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { CLOSE, type CloseReason } from '../domain/close-codes';
import {
  COLLAB_TIMINGS,
  DEFAULT_COLLAB_TIMINGS,
  DRAFT_LIMITS,
  type CollabTimings,
} from '../domain/draft-limits';
import {
  COLLAB_BACKPLANE,
  DOC_STORE,
  DRAFT_MEMBERSHIP,
  RING_REGISTRY,
  StoreUnavailableError,
  type Backplane,
  type BackplaneMessage,
  type DocStore,
  type MembershipReader,
  type RingRegistry,
} from '../domain/draft-ports';
import {
  collabConnectionsGauge,
  initDraftMetrics,
  collabRingGauge,
  collabRoomsGauge,
  collabSnapshotReadCounter,
} from './draft-metrics';
import { Room } from './room';

/**
 * Rooms on this instance (S06 WP-6): single-flight loading (50 editors opening a draft at once load it once), idle unload
 * 30 s after the last editor leaves with an unload barrier (a join during the unload waits for it and then loads a room
 * that has every earlier edit), the ring watcher that hands rooms to their new owner, and revocation: the backplane
 * triggers an immediate fresh membership read, and a periodic batched re-check (one read per shop) covers a lost notice.
 */
@Injectable()
export class RoomManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomManager.name);
  private readonly rooms = new Map<string, Promise<Room>>();
  private readonly loaded = new Map<string, Room>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly idle = new Map<string, NodeJS.Timeout>();
  private readonly timers: NodeJS.Timeout[] = [];
  private unsubscribeRing?: () => void;
  private selfId: string | null = null;
  private draining = false;
  private readonly timings: CollabTimings;

  constructor(
    @Inject(DOC_STORE) private readonly store: DocStore,
    @Inject(RING_REGISTRY) private readonly ring: RingRegistry,
    @Inject(COLLAB_BACKPLANE) private readonly backplane: Backplane,
    @Inject(DRAFT_MEMBERSHIP) private readonly membership: MembershipReader,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(COLLAB_TIMINGS) timings?: CollabTimings,
  ) {
    this.timings = { ...DEFAULT_COLLAB_TIMINGS, ...timings };
  }

  async onModuleInit() {
    initDraftMetrics();
    await this.backplane.subscribe((message) => void this.onBackplane(message));
    this.unsubscribeRing = this.ring.onChange(() => void this.onRingChange());
    this.every(this.timings.recheckMs, () => this.recheckAll());
    this.every(
      Math.max(50, Math.floor(this.timings.presenceSilenceMs / 6)),
      () => {
        for (const room of this.loaded.values()) room.sweepPresence();
        return Promise.resolve();
      },
    );
    this.every(DRAFT_LIMITS.ringRefreshMs, () => this.ring.refreshNow());
  }

  private every(ms: number, fn: () => Promise<void>) {
    const timer = setInterval(() => {
      if (this.draining) return;
      fn().catch((error: Error) =>
        this.logger.warn({ msg: 'periodic task failed', error: error.name }),
      );
    }, ms);
    timer.unref();
    this.timers.push(timer);
  }

  /** The id this instance registered in the ring with; set by the connection server. */
  bindSelf(id: string): void {
    this.selfId = id;
  }

  get self(): string | null {
    return this.selfId;
  }

  /** Whether this instance owns the draft in its view of the ring (true when no ring is known yet and no id is bound). */
  async owner(draftId: string) {
    return this.ring.ownerOf(draftId);
  }

  // ------------------------------------------------------------------------------------------ loading

  async acquire(shopId: string, draftId: string): Promise<Room> {
    // A join during an unload waits for it, then loads a room that contains every earlier edit.
    while (this.closing.has(draftId)) await this.closing.get(draftId);
    clearTimeout(this.idle.get(draftId));
    this.idle.delete(draftId);

    let room = this.rooms.get(draftId);
    if (!room) {
      room = this.store.load(shopId, draftId).then(({ doc, seq }) => {
        collabSnapshotReadCounter.add(1);
        const created = new Room({
          draftId,
          shopId,
          doc,
          seq,
          store: this.store,
          clock: this.clock,
          timings: this.timings,
          onEvict: (evicted) => this.forget(evicted),
        });
        this.loaded.set(draftId, created);
        this.gauges();
        return created;
      });
      room.catch(() => {
        if (this.rooms.get(draftId) === room) this.rooms.delete(draftId);
      });
      this.rooms.set(draftId, room);
    }
    return room;
  }

  /** The editor left: with nobody in the room it unloads after the idle period. */
  release(room: Room): void {
    this.gauges();
    if (room.connections > 0 || this.loaded.get(room.draftId) !== room) return;
    this.armIdle(room);
  }

  private armIdle(room: Room): void {
    clearTimeout(this.idle.get(room.draftId));
    const timer = setTimeout(
      () => void this.unloadIdle(room.draftId),
      this.timings.idleUnloadMs,
    );
    timer.unref();
    this.idle.set(room.draftId, timer);
  }

  private async unloadIdle(draftId: string): Promise<void> {
    this.idle.delete(draftId);
    const room = this.loaded.get(draftId);
    if (!room || room.connections > 0 || this.closing.has(draftId)) return;
    const run = (async () => {
      await room.flushNow();
      // Never drop pending updates: with the store down the room stays loaded and is retried.
      if (room.backlogBytes > 0 || room.connections > 0) {
        this.armIdle(room);
        return;
      }
      this.forget(room);
      await room.close(CLOSE.roomClosed);
    })();
    this.track(draftId, run);
    await run;
  }

  private forget(room: Room): void {
    if (this.loaded.get(room.draftId) === room) {
      this.loaded.delete(room.draftId);
      this.rooms.delete(room.draftId);
    }
    this.gauges();
  }

  private track(draftId: string, work: Promise<unknown>): void {
    const barrier = work
      .catch((error: Error) =>
        this.logger.error({
          msg: 'unload failed',
          event: 'unload_failed',
          draftId,
          error: error.name,
        }),
      )
      .then(() => undefined)
      .finally(() => {
        if (this.closing.get(draftId) === barrier) this.closing.delete(draftId);
      });
    this.closing.set(draftId, barrier);
  }

  /** A connection joined or left: refresh the gauges. */
  connectionsChanged(): void {
    this.gauges();
  }

  private gauges(): void {
    collabRoomsGauge.set(this.loaded.size);
    let connections = 0;
    for (const room of this.loaded.values()) connections += room.connections;
    collabConnectionsGauge.set(connections);
  }

  count(): number {
    return this.loaded.size;
  }

  roomOf(draftId: string): Room | undefined {
    return this.loaded.get(draftId);
  }

  // --------------------------------------------------------------------------- retiring and moving rooms

  /** Flush, compact and close one room with `close`; joins during the close wait for it. */
  private retire(
    room: Room,
    close: CloseReason,
    reasonText?: string,
  ): Promise<void> {
    clearTimeout(this.idle.get(room.draftId));
    this.idle.delete(room.draftId);
    this.forget(room);
    const work = room.close(close, reasonText).then(() => undefined);
    this.track(room.draftId, work);
    return work.catch(() => undefined);
  }

  private async onRingChange(): Promise<void> {
    collabRingGauge.set((await this.ring.members()).length);
    // An instance that left the ring (graceful stop) closes its rooms itself, with 1012 after the flush.
    if (this.draining || !this.selfId || !this.ring.registered()) return;
    for (const room of [...this.loaded.values()]) {
      const owner = await this.ring.ownerOf(room.draftId);
      if (owner && owner.id !== this.selfId)
        void this.retire(room, CLOSE.wrongInstance, owner.url);
    }
  }

  // --------------------------------------------------------------------------- freeze and flush (publish)

  private async loadedRoom(draftId: string): Promise<Room | undefined> {
    const pending = this.rooms.get(draftId);
    if (pending && !this.loaded.has(draftId))
      await pending.catch(() => undefined);
    return this.loaded.get(draftId);
  }

  /** Freeze the room of the draft for a publish; `seq` is null when no room is loaded here (the caller reads the store). */
  async freeze(
    draftId: string,
    leaseId: string,
  ): Promise<{ seq: number | null }> {
    const room = await this.loadedRoom(draftId);
    if (!room) return { seq: null };
    return { seq: await room.freeze(leaseId) };
  }

  async unfreeze(draftId: string, leaseId: string): Promise<void> {
    (await this.loadedRoom(draftId))?.unfreeze(leaseId);
  }

  /** Persist what the room has received (a named version is taken after this barrier). */
  async flush(draftId: string): Promise<{ seq: number | null }> {
    const room = await this.loadedRoom(draftId);
    if (!room) return { seq: null };
    await room.flushNow();
    if (room.backlogBytes > 0) throw new StoreUnavailableError('flush');
    return { seq: room.lastSeq };
  }

  // --------------------------------------------------------------------------------- revocation

  private async onBackplane(message: BackplaneMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'revoke':
        case 'recheck':
          await this.recheckShop(message.shopId, [message.userId]);
          return;
        case 'close-shop':
          await Promise.all(
            [...this.loaded.values()]
              .filter((r) => r.shopId === message.shopId)
              .map((r) => this.retire(r, CLOSE.shopInactive)),
          );
          return;
        case 'close-draft': {
          const room = this.loaded.get(message.draftId);
          if (room) await this.retire(room, CLOSE.draftClosed);
          return;
        }
      }
    } catch (error) {
      this.logger.warn({
        msg: 'backplane message failed',
        error: (error as Error).name,
      });
    }
  }

  /** Every 60 seconds: one membership read per shop for all users online in its rooms. */
  async recheckAll(): Promise<void> {
    const byShop = new Map<string, Set<string>>();
    for (const room of this.loaded.values()) {
      const users = byShop.get(room.shopId) ?? new Set<string>();
      room.usersOnline().forEach((u) => users.add(u));
      byShop.set(room.shopId, users);
    }
    for (const [shopId, users] of byShop)
      await this.recheckShop(shopId, [...users]).catch((error: Error) =>
        this.logger.warn({ msg: 're-check failed', error: error.name }),
      );
  }

  private async recheckShop(shopId: string, userIds: string[]): Promise<void> {
    const rooms = [...this.loaded.values()].filter((r) => r.shopId === shopId);
    if (rooms.length === 0) return;
    const access = await this.membership.accessOfMany(shopId, userIds);
    for (const [userId, result] of access) {
      for (const room of rooms) {
        if (result.kind === 'none') room.kick(userId, CLOSE.accessRevoked);
        else if (result.kind === 'inactive')
          room.kick(userId, CLOSE.shopInactive);
        else room.restrictAbility(userId, result.ability);
      }
    }
  }

  // ----------------------------------------------------------------------------------- shutdown

  /** Graceful stop: flush every room, then close the sockets with 1012 so clients reconnect through connect. */
  async drain(close: CloseReason = CLOSE.serviceRestart): Promise<void> {
    this.draining = true;
    await Promise.all(
      [...this.loaded.values()].map((room) => this.retire(room, close)),
    );
    await Promise.all([...this.closing.values()]);
  }

  async onModuleDestroy() {
    this.draining = true;
    this.timers.forEach(clearInterval);
    this.idle.forEach(clearTimeout);
    this.idle.clear();
    this.unsubscribeRing?.();
    if (this.loaded.size > 0) await this.drain();
    await this.backplane.close();
  }
}
