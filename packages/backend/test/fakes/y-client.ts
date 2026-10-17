import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_PERMISSION_DENIED = 4;

export interface YClientOptions {
  /** Do not send sync step 1 when the socket opens (the test sends its own frames). */
  manualHandshake?: boolean;
  /** Do not answer liveness pings (a sleeping laptop). */
  silent?: boolean;
  headers?: Record<string, string>;
  /** Start from this document (offline editing, resume). */
  doc?: Y.Doc;
}

/**
 * A real y-websocket client for the collab e2e specs (S06 WP-11): it speaks the binary protocol over a real `ws`
 * socket and records everything a spec asserts on: sync state, close code and reason, upgrade refusals, permission-denied
 * messages, awareness and the bytes received.
 */
export class YClient {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly ws: WebSocket;
  synced = false;
  opened = false;
  closed: { code: number; reason: string } | null = null;
  /** When the close arrived (wall clock), to order it against other events. */
  closedAt = 0;
  /** HTTP status of a refused upgrade (`401`, `403`), or `null`. */
  refused: number | null = null;
  denied: string[] = [];
  bytesReceived = 0;
  framesReceived = 0;
  readonly received: Uint8Array[] = [];

  constructor(
    readonly url: string,
    options: YClientOptions = {},
  ) {
    this.doc = options.doc ?? new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.ws = new WebSocket(url, {
      headers: options.headers,
      autoPong: !options.silent,
    });
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data: ArrayBuffer) =>
      this.onMessage(new Uint8Array(data)),
    );
    this.ws.on('unexpected-response', (_req, res) => {
      this.refused = res.statusCode ?? null;
      res.resume();
    });
    this.ws.on('open', () => {
      this.opened = true;
      if (!options.manualHandshake) this.sendStep1();
    });
    this.ws.on('close', (code, reason) => {
      this.closedAt = Date.now();
      this.closed = { code, reason: reason.toString() };
    });
    this.ws.on('error', () => undefined);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this || this.ws.readyState !== WebSocket.OPEN) return;
      this.sendUpdate(update);
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
        if (origin === 'remote' || this.ws.readyState !== WebSocket.OPEN)
          return;
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
        this.ws.send(encoding.toUint8Array(encoder));
      },
    );
  }

  sendStep1(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.ws.send(encoding.toUint8Array(encoder));
  }

  sendUpdate(update: Uint8Array): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.ws.send(encoding.toUint8Array(encoder));
  }

  /** Sends a sync step 2 (a state message) the way a read-only client must not. */
  sendStep2(update: Uint8Array): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep2);
    encoding.writeVarUint8Array(encoder, update);
    this.ws.send(encoding.toUint8Array(encoder));
  }

  sendRaw(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  private onMessage(data: Uint8Array): void {
    this.bytesReceived += data.byteLength;
    this.framesReceived += 1;
    this.received.push(data);
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const syncType = syncProtocol.readSyncMessage(
        decoder,
        encoder,
        this.doc,
        this,
      );
      if (syncType === syncProtocol.messageYjsSyncStep2) this.synced = true;
      if (encoding.length(encoder) > 1 && this.ws.readyState === WebSocket.OPEN)
        this.ws.send(encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        'remote',
      );
    } else if (type === MESSAGE_PERMISSION_DENIED) {
      this.denied.push(decoding.readVarString(decoder));
    }
  }

  title(): string {
    return this.doc.getText('title').toString();
  }

  /** Waits for sync, a close, or a refused upgrade, whichever comes first. */
  async settled(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.synced && !this.closed && this.refused === null) {
      if (Date.now() > deadline) throw new Error('client did not settle');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Waits for the first sync and fails with the reason when the server closed or refused the connection instead. */
  async whenSynced(timeoutMs = 10_000): Promise<void> {
    await this.settled(timeoutMs);
    if (!this.synced)
      throw new Error(
        this.refused !== null
          ? `upgrade refused with ${this.refused}`
          : `closed ${this.closed?.code} ${this.closed?.reason}`,
      );
  }

  close(): void {
    if (this.ws.readyState <= WebSocket.OPEN) this.ws.close();
    this.awareness.destroy();
  }

  /** Drops the connection without a close frame. */
  kill(): void {
    this.ws.terminate();
  }
}
