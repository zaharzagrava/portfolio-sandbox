import type {
  GenerationErrorCode,
  GenerationState,
} from './generation-state';

/**
 * Ports of the S46 conversation half (plan D-6, G55). `api/` and `application/` inject these tokens only; `infra/`
 * binds them (Scylla, Redis, moderation backend, billing). A spec wraps one adapter with a failure injector instead of
 * mocking the project's own stores. Every user-owned lookup takes `userId`: a foreign id is a plain miss.
 */

// ---------------------------------------------------------------- clock

/** Time source of the domain; the common `Clock` class satisfies it. */
export interface Clock {
  now(): Date;
  nowMs(): number;
}

// ---------------------------------------------------------------- conversations

export interface ConversationRecord {
  userId: string;
  conversationId: string;
  title: string;
  updatedAt: Date;
  /** Null until the lazy backfill ran on the first send (data-model). */
  messageCount: number | null;
  summary: string | null;
  /** Message id (timeuuid) the summary covers up to; only moves forward. */
  compactedUpTo: string | null;
}

export interface MessageRecord {
  messageId: string;
  role: 'user' | 'assistant';
  /** Provider content blocks as JSON, verbatim (thinking, tool_use, tool_result included). */
  content: string;
  /** The generation's `messageId`; groups the messages of one turn. */
  turnId: string;
  visibleText: string;
  toolNames: string[];
}

export interface NewMessage {
  role: 'user' | 'assistant';
  content: string;
  visibleText: string;
  toolNames: string[];
}

export interface ConversationPage {
  items: ConversationRecord[];
  /** Conversation id to resume after, absent on the last page. */
  nextAfter?: string;
}

export interface ConversationRepository {
  create(userId: string, title: string): Promise<ConversationRecord>;
  find(userId: string, conversationId: string): Promise<ConversationRecord | null>;
  list(
    userId: string,
    page: { limit: number; after?: string },
  ): Promise<ConversationPage>;
  rename(userId: string, conversationId: string, title: string): Promise<boolean>;
  /** Removes the conversation and all its messages; false when it does not exist. */
  remove(userId: string, conversationId: string): Promise<boolean>;
  /** Messages in order; `afterMessageId` skips everything up to and including it (compaction marker). */
  messages(
    userId: string,
    conversationId: string,
    options?: { afterMessageId?: string },
  ): Promise<MessageRecord[]>;
  /** Stored message count, computed once by `count(*)` when the row has none, then kept by `appendTurn`. */
  messageCount(userId: string, conversationId: string): Promise<number>;
  /** One batch: the turn's messages, `message_count += n`, `updated_at`. Only the `done` path calls it. */
  appendTurn(
    userId: string,
    conversationId: string,
    turnId: string,
    messages: NewMessage[],
  ): Promise<void>;
  /** Stores the summary and moves the marker forward only (`IF compacted_up_to < marker`); false when it did not move. */
  recordCompaction(
    userId: string,
    conversationId: string,
    summary: string,
    upToMessageId: string,
  ): Promise<boolean>;
}

// ---------------------------------------------------------------- generation store

export type GenerationEvent =
  | { type: 'meta'; data: { messageId: string; conversationId: string } }
  | { type: 'text'; data: { text: string } }
  | { type: 'tool'; data: { name: string; status: 'started' | 'finished'; [k: string]: unknown } }
  | { type: 'done'; data: Record<string, unknown> }
  | { type: 'refusal'; data: { category: string; source: string } }
  | { type: 'error'; data: { code: GenerationErrorCode; message?: string } };

export const TERMINAL_EVENT_TYPES = ['done', 'refusal', 'error'] as const;

/** An event with the stream entry id it was stored under (`<ms>-<seq>`, also the SSE id). */
export interface StoredEvent {
  id: string;
  event: GenerationEvent;
}

export interface GenerationMeta {
  conversationId: string;
  state: GenerationState;
  startedAt: number;
  endedAt?: number;
  cancelRequested: boolean;
}

export interface GenerationStore {
  /** Creates the generation (meta + stream). Idempotent per `messageId`. */
  start(userId: string, messageId: string, conversationId: string): Promise<void>;
  /** Appends a non-terminal event; returns its id. Ids strictly increase. */
  append(userId: string, messageId: string, event: GenerationEvent): Promise<string>;
  /**
   * Appends the terminal event exactly once (atomic guard): returns the stored entry, or null when a terminal event
   * already exists (a racing reporter lost).
   */
  finish(userId: string, messageId: string, event: GenerationEvent): Promise<StoredEvent | null>;
  /** Events after `afterId` (exclusive; absent = from the start), at most `limit`. Foreign/unknown/expired -> null. */
  read(
    userId: string,
    messageId: string,
    afterId: string | undefined,
    limit: number,
  ): Promise<StoredEvent[] | null>;
  /** Waits up to `blockMs` for events after `afterId`; null when the generation is unknown to the caller. */
  wait(
    userId: string,
    messageId: string,
    afterId: string,
    blockMs: number,
  ): Promise<StoredEvent[] | null>;
  meta(userId: string, messageId: string): Promise<GenerationMeta | null>;
  /** Marks a cancel request; returns the state seen (so the caller answers 409 on a terminal one). */
  requestCancel(userId: string, messageId: string): Promise<GenerationState | null>;
  /** Generator liveness, refreshed every second. */
  heartbeat(userId: string, messageId: string): Promise<void>;
  /** Viewer presence for the grace period (AS-26); returns whether any viewer is attached. */
  touchViewer(userId: string, messageId: string, viewerId: string): Promise<void>;
  hasViewers(userId: string, messageId: string): Promise<boolean>;
  /** True when neither liveness nor a terminal event exists (the generator is gone). */
  isLost(userId: string, messageId: string): Promise<boolean>;
  /** In-process fast path for a cancel requested on this instance (the generator also polls `meta`). */
  onCancel(userId: string, messageId: string, listener: () => void): () => void;
  /** Generations started on this instance and not yet finished (shutdown drain, active-streams gauge). */
  localGenerations(): number;
}

// ---------------------------------------------------------------- moderation

export type ModerationVerdict =
  | { flagged: false }
  | { flagged: true; category: string };

export interface ModerationPort {
  /** Rejects with a typed unavailable error when the backend cannot answer (fail closed, AS-55). */
  checkInput(text: string): Promise<ModerationVerdict>;
  checkOutput(text: string): Promise<ModerationVerdict>;
}

// ---------------------------------------------------------------- allowance

export interface QuotaCounter {
  /** Tokens used in the month; seeds from billing when the counter is absent; rejects when unreadable (fail closed). */
  used(userId: string, month: string): Promise<number>;
  /** Idempotent per `callId`: a call charged twice counts once. Returns the new total. */
  charge(
    userId: string,
    month: string,
    callId: string,
    billableTokens: number,
  ): Promise<number>;
}

// ---------------------------------------------------------------- admission

export interface IdempotencyRecord {
  fingerprint: string;
  messageId: string;
}

export type IdempotencyClaim =
  | { kind: 'claimed' }
  | { kind: 'existing'; record: IdempotencyRecord };

export interface AdmissionStore {
  /** `SET NX` of the key with the request fingerprint and the new message id. */
  claimIdempotency(
    userId: string,
    key: string,
    record: IdempotencyRecord,
  ): Promise<IdempotencyClaim>;
  /** Compare-and-delete on the message id ("released when rejected before generating"). */
  releaseIdempotency(userId: string, key: string, messageId: string): Promise<void>;
  /** One reply per conversation; false when held. */
  acquireLock(
    userId: string,
    conversationId: string,
    messageId: string,
    ttlMs: number,
  ): Promise<boolean>;
  releaseLock(userId: string, conversationId: string, messageId: string): Promise<void>;
  /** Active replies per user, capped atomically; false when the cap is reached. */
  acquireSlot(
    userId: string,
    messageId: string,
    cap: number,
    ttlMs: number,
  ): Promise<boolean>;
  releaseSlot(userId: string, messageId: string): Promise<void>;
  /** Fleet-wide "not before" per model after a provider 429 (`Retry-After`). */
  setCooldown(model: string, durationMs: number): Promise<void>;
  /** Milliseconds until the model may be called again; 0 when free. */
  cooldownRemainingMs(model: string): Promise<number>;
}

// ---------------------------------------------------------------- tools

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON schema of the input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  userId: string;
  conversationId: string;
  signal: AbortSignal;
  location?: { lat: number; lng: number };
}

export type ToolResult =
  | { ok: true; content: unknown }
  | { ok: false; error: string };

export interface ToolCatalog {
  definitions(): ToolDefinition[];
  /** Never throws for a tool failure: the error is returned to the model as a tool result. */
  execute(name: string, input: unknown, context: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------- tokens

export const CONVERSATION_REPOSITORY = Symbol('ASSISTANT_CONVERSATION_REPOSITORY');
export const GENERATION_STORE = Symbol('ASSISTANT_GENERATION_STORE');
export const MODERATION_PORT = Symbol('ASSISTANT_MODERATION_PORT');
export const QUOTA_COUNTER = Symbol('ASSISTANT_QUOTA_COUNTER');
export const ASSISTANT_CLOCK = Symbol('ASSISTANT_CLOCK');
export const ADMISSION_STORE = Symbol('ASSISTANT_ADMISSION_STORE');
export const TOOL_CATALOG = Symbol('ASSISTANT_TOOL_CATALOG');
