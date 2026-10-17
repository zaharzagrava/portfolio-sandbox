import { Logger } from '@nestjs/common';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { Clock } from '@app/common/core/clock';
import {
  CLOSE,
  MESSAGE_PERMISSION_DENIED,
  type CloseReason,
} from '../domain/close-codes';
import { DRAFT_LIMITS, type CollabTimings } from '../domain/draft-limits';
import {
  SequenceConflictError,
  StoreUnavailableError,
  type DocStore,
} from '../domain/draft-ports';
import {
  FrameRate,
  abilityAllows,
  checkFrameSize,
  classifyFrame,
  isEmptyStateFrame,
  type Ability,
} from '../domain/frame-policy';
import {
  collabBroadcastSeconds,
  collabCloseCounter,
  collabDeniedWriteCounter,
  collabFlushSeconds,
  collabSequenceConflictCounter,
  collabStoreErrorCounter,
  collabUpdateCounter,
} from './draft-metrics';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/** Minimal surface of a `ws` WebSocket, so rooms are testable without sockets. */
export interface RoomSocket {
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

export type JoinResult = { ok: true } | { ok: false; close: CloseReason };

interface Member {
  connectionId: string;
  userId: string;
  ability: Ability;
  awarenessIds: Set<number>;
  lastPresenceAt: number;
  rate: FrameRate;
}

export interface RoomOptions {
  draftId: string;
  shopId: string;
  doc: Y.Doc;
  seq: number;
  store: DocStore;
  clock: Clock;
  timings: CollabTimings;
  /** The log refused a write because another writer owns the document: the manager drops this room. */
  onEvict: (room: Room) => void;
}

let connectionCounter = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One in-memory Y.Doc per draft, on the instance that owns the draft (ring), speaking the y-websocket protocol (sync
 * step 1/2/update + awareness). Depends on ports only (S06 I, D-6).
 *
 *  - Every frame is classified and checked before anything is applied: malformed (4000), too large (1009), rate (4029),
 *    frozen (4005), and the sender's ability for that frame type (a read-only member's state frames are answered with a
 *    permission-denied message and dropped, the connection stays open).
 *  - Updates are broadcast at once and persisted as ONE merged update per 100 ms flush; a failed write is retried with
 *    exponential backoff and jitter, never dropped; after 8 MiB or 30 s of backlog writers are closed (4013).
 *  - Presence is relayed, owned per connection, size capped, and never persisted.
 */
export class Room {
  private readonly logger = new Logger('Room');
  readonly draftId: string;
  readonly shopId: string;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  private readonly members = new Map<RoomSocket, Member>();
  private readonly store: DocStore;
  private readonly clock: Clock;
  private readonly timings: CollabTimings;
  private readonly onEvict: (room: Room) => void;

  private seq: number;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private inflight: Uint8Array | null = null;
  private chain: Promise<void> = Promise.resolve();
  private flushTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private sinceCompaction = 0;
  private backlogSince: number | null = null;
  private sizeEstimate: number;
  private frozenBy: string | null = null;
  private disposed = false;
  /** Writers are refused while the store has been down past the backlog limit. */
  degraded = false;
  evicted = false;

  constructor(options: RoomOptions) {
    this.draftId = options.draftId;
    this.shopId = options.shopId;
    this.doc = options.doc;
    this.seq = options.seq;
    this.store = options.store;
    this.clock = options.clock;
    this.timings = options.timings;
    this.onEvict = options.onEvict;
    this.sizeEstimate = Y.encodeStateAsUpdate(this.doc).byteLength;

    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null); // the server has no cursor
    // The room sweeps silent presence itself, on the shared clock and the configured period.
    clearInterval(
      (this.awareness as unknown as { _checkInterval: NodeJS.Timeout })
        ._checkInterval,
    );

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const started = process.hrtime.bigint();
      this.broadcast(encodeUpdate(update), origin as RoomSocket | undefined);
      collabBroadcastSeconds.record(
        Number(process.hrtime.bigint() - started) / 1e9,
      );
      this.pending.push(update);
      this.pendingBytes += update.byteLength;
      this.flushTimer ??= setTimeout(() => {
        this.flushTimer = undefined;
        void this.flushNow();
      }, this.timings.flushBatchMs);
    });

    this.awareness.on(
      'update',
      (
        {
          added,
          updated,
          removed,
        }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const member = this.members.get(origin as RoomSocket);
        if (member) {
          added.forEach((id) => member.awarenessIds.add(id));
          removed.forEach((id) => member.awarenessIds.delete(id));
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            ...added,
            ...updated,
            ...removed,
          ]),
        );
        this.broadcast(encoding.toUint8Array(encoder));
      },
    );
  }

  // ------------------------------------------------------------------------------------------------ membership

  get connections(): number {
    return this.members.size;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get isFrozen(): boolean {
    return this.frozenBy !== null;
  }

  usersOnline(): string[] {
    return [...new Set([...this.members.values()].map((m) => m.userId))];
  }

  hasWriters(): boolean {
    return [...this.members.values()].some((m) => m.ability === 'write');
  }

  join(socket: RoomSocket, userId: string, ability: Ability): JoinResult {
    // The room was unloaded or evicted between the manager handing it out and this call: reconnect through connect.
    if (this.disposed || this.evicted)
      return { ok: false, close: CLOSE.roomMoved };
    if (this.members.size >= DRAFT_LIMITS.connectionsPerRoom)
      return { ok: false, close: CLOSE.roomFull };
    const own = [...this.members.values()].filter((m) => m.userId === userId);
    if (own.length >= DRAFT_LIMITS.connectionsPerUser)
      return { ok: false, close: CLOSE.tooManyConnections };
    // A writer cannot join a frozen or degraded room: it would be refused at its first update anyway.
    const effective: Ability =
      this.degraded || this.frozenBy ? 'read' : ability;
    if (this.degraded && ability === 'write')
      return { ok: false, close: CLOSE.storeUnavailable };

    this.members.set(socket, {
      connectionId: `c${++connectionCounter}`,
      userId,
      ability: effective,
      awarenessIds: new Set(),
      lastPresenceAt: this.clock.nowMs(),
      rate: new FrameRate(),
    });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    socket.send(encoding.toUint8Array(encoder));

    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        aw,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, states),
      );
      socket.send(encoding.toUint8Array(aw));
    }
    return { ok: true };
  }

  leave(socket: RoomSocket): void {
    const member = this.members.get(socket);
    if (!member) return;
    this.members.delete(socket);
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [...member.awarenessIds],
      null,
    );
  }

  idForLog(socket: RoomSocket): { connectionId?: string; userId?: string } {
    const member = this.members.get(socket);
    return { connectionId: member?.connectionId, userId: member?.userId };
  }

  private closeMember(
    socket: RoomSocket,
    close: CloseReason,
    reasonText?: string,
  ) {
    this.leave(socket);
    collabCloseCounter.add(1, { code: `${close.code}` });
    try {
      socket.close(close.code, reasonText ?? close.reason);
    } catch {
      // the peer is already gone
    }
  }

  /** Access revoked or the shop is no longer active: close every socket of that user (4003). */
  kick(userId: string, close: CloseReason = CLOSE.accessRevoked): number {
    let closed = 0;
    for (const [socket, member] of [...this.members])
      if (member.userId === userId) {
        this.closeMember(socket, close);
        closed++;
      }
    return closed;
  }

  /**
   * The member's fresh ability (re-check or role event). Losing write keeps the connection open, read-only; gaining write
   * takes effect on the next connect with a new ticket, never on a socket that joined read-only.
   */
  restrictAbility(userId: string, fresh: Ability): void {
    if (fresh !== 'read') return;
    for (const member of this.members.values())
      if (member.userId === userId) member.ability = 'read';
  }

  get backlogBytes(): number {
    return this.backlog();
  }

  closeAll(close: CloseReason, reasonText?: string): void {
    for (const socket of [...this.members.keys()])
      this.closeMember(socket, close, reasonText);
  }

  // ----------------------------------------------------------------------------------------------- frames

  handleMessage(socket: RoomSocket, data: Uint8Array): void {
    const member = this.members.get(socket);
    if (!member || this.disposed || this.evicted) return;

    if (member.rate.hit(this.clock.nowMs()))
      return this.closeMember(socket, CLOSE.rateLimited);
    const kind = classifyFrame(data);
    if (kind === 'malformed')
      return this.closeMember(socket, CLOSE.protocolError);
    if (checkFrameSize(kind, data.byteLength) === 'too_large')
      return this.closeMember(socket, CLOSE.frameTooLarge);

    if (kind === 'awareness') return this.applyPresence(socket, member, data);
    if (kind === 'query-awareness') return this.sendAwareness(socket);

    if (!abilityAllows(member.ability, kind)) {
      // The empty step 2 every client sends to answer the server's step 1 carries no change: not a write.
      if (kind === 'sync-step2' && isEmptyStateFrame(data)) return;
      this.deny(socket, member, 'read_only');
      return;
    }
    if ((kind === 'sync-update' || kind === 'sync-step2') && this.frozenBy) {
      collabDeniedWriteCounter.add(1, { reason: 'frozen' });
      return this.closeMember(socket, CLOSE.draftClosed);
    }
    if (this.degraded && (kind === 'sync-update' || kind === 'sync-step2'))
      return this.closeMember(socket, CLOSE.storeUnavailable);

    const decoder = decoding.createDecoder(data);
    decoding.readVarUint(decoder); // MESSAGE_SYNC
    const syncType = decoding.readVarUint(decoder);
    if (syncType === syncProtocol.messageYjsSyncStep1) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncStep1(decoder, encoder, this.doc);
      socket.send(encoding.toUint8Array(encoder));
      return;
    }
    const update = decoding.readVarUint8Array(decoder);
    if (!this.fitsDocument(update)) {
      collabUpdateCounter.add(1, { result: 'too_large' });
      return this.closeMember(socket, CLOSE.documentTooLarge);
    }
    try {
      Y.applyUpdate(this.doc, update, socket);
      collabUpdateCounter.add(1, { result: 'accepted' });
    } catch {
      this.closeMember(socket, CLOSE.protocolError);
    }
  }

  /** Whether applying `update` keeps the encoded document within 2 MiB; exact only near the limit (a cheap bound before). */
  private fitsDocument(update: Uint8Array): boolean {
    if (this.sizeEstimate + update.byteLength <= DRAFT_LIMITS.documentBytes) {
      this.sizeEstimate += update.byteLength;
      return true;
    }
    const trial = new Y.Doc();
    try {
      Y.applyUpdate(trial, Y.encodeStateAsUpdate(this.doc));
      Y.applyUpdate(trial, update);
      const exact = Y.encodeStateAsUpdate(trial).byteLength;
      if (exact > DRAFT_LIMITS.documentBytes) return false;
      this.sizeEstimate = exact;
      return true;
    } catch {
      return false;
    } finally {
      trial.destroy();
    }
  }

  private deny(socket: RoomSocket, member: Member, reason: 'read_only') {
    collabUpdateCounter.add(1, { result: 'denied' });
    collabDeniedWriteCounter.add(1, { reason });
    this.logger.warn({
      msg: 'write denied',
      event: 'write_denied',
      reason,
      connectionId: member.connectionId,
      draftId: this.draftId,
      shopId: this.shopId,
      userId: member.userId,
    });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_PERMISSION_DENIED);
    encoding.writeVarString(encoder, reason);
    socket.send(encoding.toUint8Array(encoder));
  }

  private sendAwareness(socket: RoomSocket) {
    const states = [...this.awareness.getStates().keys()];
    if (states.length === 0) return;
    const aw = encoding.createEncoder();
    encoding.writeVarUint(aw, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      aw,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, states),
    );
    socket.send(encoding.toUint8Array(aw));
  }

  /** Presence: ignored when it names a presence id announced by another connection (or the room's own). */
  private applyPresence(socket: RoomSocket, member: Member, data: Uint8Array) {
    const decoder = decoding.createDecoder(data);
    decoding.readVarUint(decoder);
    const payload = decoding.readVarUint8Array(decoder);
    let ids: number[];
    try {
      const inner = decoding.createDecoder(payload);
      const count = decoding.readVarUint(inner);
      ids = [];
      for (let i = 0; i < count; i++) {
        ids.push(decoding.readVarUint(inner));
        decoding.readVarUint(inner); // clock
        decoding.readVarString(inner); // state (JSON)
      }
    } catch {
      return this.closeMember(socket, CLOSE.protocolError);
    }
    for (const id of ids) {
      if (id === this.awareness.clientID) return;
      for (const [other, m] of this.members)
        if (other !== socket && m.awarenessIds.has(id)) return;
    }
    member.lastPresenceAt = this.clock.nowMs();
    awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, socket);
  }

  /** Removes the presence of connections that have been silent for the configured period; the connection itself stays. */
  sweepPresence(): void {
    const now = this.clock.nowMs();
    for (const member of this.members.values())
      if (
        member.awarenessIds.size > 0 &&
        now - member.lastPresenceAt >= this.timings.presenceSilenceMs
      )
        awarenessProtocol.removeAwarenessStates(
          this.awareness,
          [...member.awarenessIds],
          null,
        );
  }

  private broadcast(message: Uint8Array, except?: RoomSocket): void {
    for (const socket of this.members.keys())
      if (socket !== except) socket.send(message);
  }

  // ------------------------------------------------------------------------------------------- persistence

  /** Persists everything pending (serialised with every other flush). */
  flushNow(): Promise<void> {
    this.chain = this.chain.then(() => this.drain()).catch(() => undefined);
    return this.chain;
  }

  private backlog(): number {
    return this.pendingBytes + (this.inflight?.byteLength ?? 0);
  }

  private async drain(): Promise<void> {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    while (!this.disposed && !this.evicted) {
      if (!this.inflight) {
        if (this.pending.length === 0) break;
        this.inflight = Y.mergeUpdates(this.pending);
        this.pending = [];
        this.pendingBytes = 0;
      }
      const written = await this.writeInflight();
      if (written === 'conflict') return;
      if (written === 'failed') {
        this.scheduleRetry();
        return;
      }
    }
    this.backlogSince = null;
    if (this.degraded) this.degraded = false;
    if (this.sinceCompaction >= DRAFT_LIMITS.flushesPerCompaction)
      await this.compact();
  }

  /** At most 3 attempts with exponential backoff and full jitter; identical bytes already stored count as written. */
  private async writeInflight(): Promise<'written' | 'failed' | 'conflict'> {
    const batch = this.inflight!;
    const started = process.hrtime.bigint();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const last = await this.store.append(this.draftId, this.seq + 1, batch);
        this.seq = last;
        this.inflight = null;
        this.sinceCompaction++;
        collabFlushSeconds.record(
          Number(process.hrtime.bigint() - started) / 1e9,
        );
        return 'written';
      } catch (error) {
        if (error instanceof SequenceConflictError) {
          collabSequenceConflictCounter.add(1);
          this.evict();
          return 'conflict';
        }
        collabStoreErrorCounter.add(1, { operation: 'flush' });
        if (!(error instanceof StoreUnavailableError))
          this.logger.error({
            msg: 'flush failed',
            event: 'flush_failed',
            draftId: this.draftId,
          });
        if (attempt < 2) await sleep(this.backoff(attempt));
      }
    }
    this.noteBacklog();
    return 'failed';
  }

  private backoff(attempt: number): number {
    const ceiling = Math.min(
      this.timings.retryCapMs,
      this.timings.retryBaseMs * 2 ** attempt,
    );
    return Math.floor(Math.random() * ceiling);
  }

  private noteBacklog(): void {
    const now = this.clock.nowMs();
    this.backlogSince ??= now;
    if (
      !this.degraded &&
      (this.backlog() >= DRAFT_LIMITS.backlogBytes ||
        now - this.backlogSince >= DRAFT_LIMITS.backlogMs)
    ) {
      this.degraded = true;
      for (const [socket, member] of [...this.members])
        if (member.ability === 'write')
          this.closeMember(socket, CLOSE.storeUnavailable);
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || this.evicted) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flushNow();
    }, this.timings.retryCapMs);
  }

  private async compact(): Promise<void> {
    try {
      await this.store.compact(this.shopId, this.draftId, this.doc, this.seq);
      this.sinceCompaction = 0;
    } catch (error) {
      collabStoreErrorCounter.add(1, { operation: 'compact' });
      this.logger.warn({
        msg: 'compaction failed',
        event: 'compact_failed',
        draftId: this.draftId,
      });
      void error; // pending compaction is retried by the next flush
    }
  }

  /** Another writer owns this document: stop writing, tell the clients to reconnect to the owner. */
  private evict(): void {
    if (this.evicted) return;
    this.evicted = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    this.closeAll(CLOSE.roomMoved);
    this.onEvict(this);
    this.dispose();
  }

  // ----------------------------------------------------------------------------------------------- freezing

  /**
   * Publish freezes the room: updates received before this call are flushed and included, later ones close the sender
   * with 4005. Returns the sequence number of the last persisted entry.
   */
  async freeze(leaseId: string): Promise<number> {
    this.frozenBy = leaseId;
    await this.flushNow();
    if (this.backlog() > 0 || this.evicted)
      throw new StoreUnavailableError('freeze flush');
    return this.seq;
  }

  /** The publisher failed and released its claim: the room accepts writes again. */
  unfreeze(leaseId: string): void {
    if (this.frozenBy === leaseId) this.frozenBy = null;
  }

  // -------------------------------------------------------------------------------------------------- unload

  /**
   * Flush, compact and close every socket with `close`. Returns false when the pending updates could not be persisted
   * (the caller keeps the room instead of unloading it when it can).
   */
  async close(
    close: CloseReason = CLOSE.roomClosed,
    reasonText?: string,
  ): Promise<boolean> {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.flushNow();
    const flushed = this.backlog() === 0;
    if (flushed && this.sinceCompaction > 0 && !this.evicted)
      await this.compact();
    this.closeAll(close, reasonText);
    this.dispose();
    return flushed;
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    this.members.clear();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

function encodeUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}
