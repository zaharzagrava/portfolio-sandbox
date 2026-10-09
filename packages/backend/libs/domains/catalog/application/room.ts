import { Logger } from '@nestjs/common';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { DraftStore } from '../infra/draft-store';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/** Minimal surface of a `ws` WebSocket, so rooms are testable without sockets. */
export interface RoomSocket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface Member {
  userId: string;
  canWrite: boolean;
  awarenessIds: Set<number>;
}

const FLUSH_MS = 100;
const COMPACT_EVERY = 200;

/**
 * One in-memory Y.Doc per draft, on the instance that owns the draft (ring).
 * Speaks the y-websocket protocol (sync step1/step2/update + awareness).
 *
 *  - Writes are permission-checked PER MESSAGE: a viewer may send sync step 1
 *    (to receive state) but its step 2 / update messages are dropped.
 *  - Updates are broadcast immediately and persisted as ONE merged update per
 *    100 ms flush (Y.mergeUpdates) → one conditional Dynamo put per flush, not
 *    per keystroke.
 *  - Every 200 flushes (and on unload) the state is compacted to S3.
 *  - Awareness (cursors, names, selections) is relayed but never persisted.
 */
export class Room {
  private readonly logger = new Logger(`Room`);
  readonly members = new Map<RoomSocket, Member>();
  readonly awareness: awarenessProtocol.Awareness;
  private pending: Uint8Array[] = [];
  private flushing: Promise<void> = Promise.resolve();
  private flushTimer?: NodeJS.Timeout;
  private sinceCompaction = 0;
  failed = false;

  constructor(
    readonly draftId: string,
    readonly doc: Y.Doc,
    private seq: number,
    private readonly store: DraftStore,
    private readonly onFatal: (room: Room) => void,
  ) {
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.awareness.setLocalState(null); // the server has no cursor

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.broadcast(encodeUpdate(update), origin as RoomSocket | undefined);
      this.pending.push(update);
      this.flushTimer ??= setTimeout(() => this.scheduleFlush(), FLUSH_MS);
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
        const changed = [...added, ...updated, ...removed];
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        );
        this.broadcast(encoding.toUint8Array(encoder));
      },
    );
  }

  join(socket: RoomSocket, userId: string, canWrite: boolean) {
    this.members.set(socket, { userId, canWrite, awarenessIds: new Set() });
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
  }

  leave(socket: RoomSocket) {
    const member = this.members.get(socket);
    if (!member) return;
    this.members.delete(socket);
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [...member.awarenessIds],
      null,
    );
  }

  /** Access revoked mid-session: close that user's sockets (4003 = forbidden). */
  kick(userId: string) {
    for (const [socket, member] of this.members) {
      if (member.userId !== userId) continue;
      this.leave(socket);
      socket.close(4003, 'access revoked');
    }
  }

  handleMessage(socket: RoomSocket, data: Uint8Array) {
    const member = this.members.get(socket);
    if (!member || this.failed) return;
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);

    if (type === MESSAGE_SYNC) {
      // Peek at the sync sub-type without consuming the real decoder.
      const peek = decoding.createDecoder(data);
      decoding.readVarUint(peek);
      const syncType = decoding.readVarUint(peek);
      if (syncType !== syncProtocol.messageYjsSyncStep1 && !member.canWrite)
        return; // viewer tried to write

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, socket);
      if (encoding.length(encoder) > 1)
        socket.send(encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        socket,
      );
    }
  }

  /** Persist everything pending and snapshot (room unload / shutdown). */
  async close(): Promise<void> {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.flush();
    if (!this.failed && this.sinceCompaction > 0)
      await this.store.compact(this.draftId, this.doc, this.seq);
    for (const socket of this.members.keys()) socket.close(1001, 'room closed');
    this.members.clear();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private scheduleFlush() {
    this.flushTimer = undefined;
    this.flushing = this.flushing.then(() => this.flush());
  }

  private async flush() {
    if (this.pending.length === 0 || this.failed) return;
    const batch = this.pending;
    this.pending = [];
    const merged = Y.mergeUpdates(batch);
    try {
      await this.store.append(this.draftId, this.seq + 1, merged);
      this.seq++;
      if (++this.sinceCompaction >= COMPACT_EVERY) {
        await this.store.compact(this.draftId, this.doc, this.seq);
        this.sinceCompaction = 0;
      }
    } catch (error) {
      // Seq conflict = another instance is writing this doc (ring changed under us). Stop and let clients reconnect to the owner.
      this.logger.error(
        `room ${this.draftId} persistence failed: ${(error as Error).message}`,
      );
      this.failed = true;
      for (const socket of this.members.keys())
        socket.close(4002, 'room moved, reconnect');
      this.onFatal(this);
    }
  }

  private broadcast(message: Uint8Array, except?: RoomSocket) {
    for (const socket of this.members.keys())
      if (socket !== except) socket.send(message);
  }
}

function encodeUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}
