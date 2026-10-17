import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { problemFromError, type Problem } from '@/lib/api/errors';

/**
 * The editing connection of a listing draft (S06 `contracts/collab-ws.md`): the y-websocket binary protocol (sync step 1 and
 * 2, updates) plus one server message, type 4, for a denied write. Presence is not used. A connection ticket is single use,
 * so every new connection asks the API for a ticket first, except `4001` (wrong instance), which goes to the address the
 * server names with the same ticket. The document keeps local edits while the connection is down and reconciles on the next
 * sync. Framework free: the editor reads it through `subscribe` and `getSnapshot`.
 */

const MESSAGE_SYNC = 0;
const MESSAGE_PERMISSION_DENIED = 4;

/** The close codes of the contract. */
export const CLOSE = {
  roomClosed: 1001,
  frameTooLarge: 1009,
  serviceRestart: 1012,
  protocolError: 4000,
  wrongInstance: 4001,
  roomMoved: 4002,
  accessRevoked: 4003,
  draftNotFound: 4004,
  draftClosed: 4005,
  roomFull: 4008,
  documentTooLarge: 4009,
  storeUnavailable: 4013,
  rateLimited: 4029,
} as const;

export type ConnectInfo = { url: string; ticket: string; canWrite: boolean; expiresAt: string };

/** What the socket needs to look like: the browser's `WebSocket` and the test stub both fit. */
export type SocketLike = {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type StopReason = 'draft_not_found' | 'access_revoked' | 'shop_inactive' | 'protocol_error' | 'room_full' | 'document_too_large' | 'frame_too_large' | 'forbidden' | 'session_ended';
export type SessionStatus = 'connecting' | 'live' | 'reconnecting' | 'stopped';

export type SessionState = {
  status: SessionStatus;
  /** Sync step 2 received on the current connection: the document is the server's. */
  synced: boolean;
  /** The document has been the server's at least once, so its fields are real and may be edited (also while the link is down). */
  everSynced: boolean;
  canWrite: boolean;
  /** The server refused a change with type 4 (`read_only`). */
  denied: boolean;
  /** Reconnects tried since the last good sync. */
  attempt: number;
  /** Whole seconds until the next try, when that is one second or more. */
  retryInSeconds?: number;
  /** Changes with every scheduled retry, so a countdown restarts when the same number comes twice. */
  retryToken: number;
  stopReason?: StopReason;
};

export type Backoff = { baseMs: number; maxMs: number; /** Spread each wait over its upper half; off in tests. */ jitter?: boolean };
export const DEFAULT_BACKOFF: Backoff = { baseMs: 1_000, maxMs: 30_000, jitter: true };

/** `base * 2^attempt`, at most `maxMs`; with `jitter` a random value in the upper half of that. */
export function backoffDelay(attempt: number, backoff: Backoff = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const wait = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.max(0, attempt));
  return backoff.jitter ? Math.round(wait / 2 + (wait / 2) * random()) : wait;
}

const OPEN = 1;
/** After this many `4001` hops in a row the owner is not found; the normal backoff takes over. */
const MAX_REDIRECTS = 3;
const MAX_DRAFT_CLOSED_RETRIES = 2;

export type SessionOptions = {
  doc: Y.Doc;
  /** Asks the API for a ticket (`POST …/connect`). */
  connect: () => Promise<ConnectInfo>;
  createSocket: (url: string) => SocketLike;
  backoff?: Backoff;
};

export class CollabSession {
  readonly doc: Y.Doc;
  private readonly options: SessionOptions;
  private readonly backoff: Backoff;
  private readonly listeners = new Set<() => void>();
  private state: SessionState = { status: 'connecting', synced: false, everSynced: false, canWrite: false, denied: false, attempt: 0, retryToken: 0 };
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private baseUrl = '';
  private redirects = 0;
  private closedRetries = 0;
  private everLive = false;

  constructor(options: SessionOptions) {
    this.options = options;
    this.doc = options.doc;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.doc.on('update', this.onDocUpdate);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getSnapshot = (): SessionState => this.state;

  start(): void {
    void this.open();
  }

  /** After a stop the member chose to try again ("Try again" on a full room). */
  restart(): void {
    if (this.destroyed) return;
    this.redirects = 0;
    this.closedRetries = 0;
    this.set({ attempt: 0, stopReason: undefined, retryInSeconds: undefined });
    void this.open();
  }

  destroy(): void {
    this.destroyed = true;
    this.doc.off('update', this.onDocUpdate);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close(1000);
    }
    this.listeners.clear();
  }

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private async open(): Promise<void> {
    if (this.destroyed) return;
    this.timer = null;
    this.set({ status: this.everLive ? 'reconnecting' : 'connecting', retryInSeconds: undefined });
    let info: ConnectInfo;
    try {
      info = await this.options.connect();
    } catch (error) {
      if (!this.destroyed) this.onConnectError(problemFromError(error));
      return;
    }
    if (this.destroyed) return;
    this.set({ canWrite: info.canWrite, denied: false });
    this.baseUrl = info.url;
    this.attach(info.url, info.ticket);
  }

  private onConnectError(problem: Problem): void {
    if (problem.status === 401) return this.stop('session_ended');
    if (problem.status === 404) return this.stop('draft_not_found');
    if (problem.status === 403) return this.stop(problem.code === 'shop_suspended' ? 'shop_inactive' : 'forbidden');
    if (problem.code === 'shop_offboarding') return this.stop('shop_inactive');
    // 429, 503 `collab_unavailable` and anything else: wait at least as long as the server asked.
    const asked = (problem.retryAfterSeconds ?? 0) * 1_000;
    this.schedule(Math.max(asked, backoffDelay(this.state.attempt, this.backoff)));
  }

  private attach(base: string, ticket: string): void {
    const url = new URL(base);
    url.searchParams.set('ticket', ticket);
    const socket = this.options.createSocket(url.toString());
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.everLive = true;
      this.set({ status: 'live', retryInSeconds: undefined });
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      socket.send(encoding.toUint8Array(encoder));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.onMessage(socket, event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onClose(event.code, event.reason, ticket);
    };
    socket.onerror = () => undefined;
  }

  private onMessage(socket: SocketLike, data: unknown): void {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const kind = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      // Only the header is in the reply when there is nothing to answer.
      if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
      if (kind === syncProtocol.messageYjsSyncStep2 && !this.state.synced) {
        this.redirects = 0;
        this.closedRetries = 0;
        this.set({ synced: true, everSynced: true, attempt: 0 });
      }
    } else if (type === MESSAGE_PERMISSION_DENIED) {
      this.set({ denied: true });
    }
  }

  private onClose(code: number, reason: string, ticket: string): void {
    this.set({ synced: false });
    switch (code) {
      case CLOSE.wrongInstance:
        if (this.redirects < MAX_REDIRECTS) {
          this.redirects += 1;
          this.attach(ownerUrl(this.baseUrl, reason), ticket);
          return;
        }
        return this.schedule(backoffDelay(this.state.attempt, this.backoff));
      case CLOSE.protocolError:
        return this.stop('protocol_error');
      case CLOSE.accessRevoked:
        return this.stop(reason === 'shop_inactive' ? 'shop_inactive' : 'access_revoked');
      case CLOSE.draftNotFound:
        return this.stop('draft_not_found');
      case CLOSE.roomFull:
        return this.stop('room_full');
      case CLOSE.documentTooLarge:
        return this.stop('document_too_large');
      case CLOSE.frameTooLarge:
        return this.stop('frame_too_large');
      case CLOSE.draftClosed:
        // The draft was published or archived: connecting again gives a read-only ticket.
        if (this.closedRetries < MAX_DRAFT_CLOSED_RETRIES) {
          this.closedRetries += 1;
          return this.schedule(0);
        }
        return this.schedule(backoffDelay(this.state.attempt, this.backoff));
      case CLOSE.rateLimited:
        return this.schedule(Math.max(backoffDelay(this.state.attempt, this.backoff), 10_000));
      default:
        // 1001, 1006, 1012, 4002, 4013 and anything unknown: a new ticket after the backoff.
        return this.schedule(backoffDelay(this.state.attempt, this.backoff));
    }
  }

  private schedule(delayMs: number): void {
    if (this.destroyed) return;
    const attempt = this.state.attempt + 1;
    this.set({ status: 'reconnecting', attempt, retryToken: this.state.retryToken + 1, retryInSeconds: delayMs >= 1_000 ? Math.ceil(delayMs / 1_000) : undefined });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.open(), delayMs);
  }

  private stop(reason: StopReason): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close(1000);
    }
    this.set({ status: 'stopped', stopReason: reason, synced: false, retryInSeconds: undefined });
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Remote changes (origin is this session) are not sent back; nothing is sent without write access.
    if (origin === this || !this.state.canWrite || this.state.denied) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    socket.send(encoding.toUint8Array(encoder));
  };
}

/** The address named by `4001`: a full `ws(s)` URL, or a host that replaces the host of the address first used. */
export function ownerUrl(base: string, reason: string): string {
  const named = reason.trim();
  if (/^wss?:\/\//i.test(named)) return named;
  const url = new URL(base);
  url.host = named;
  return url.toString();
}
