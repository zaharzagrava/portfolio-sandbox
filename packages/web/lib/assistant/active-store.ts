import { z } from 'zod';
import { subscribeAuth } from '@/lib/auth/session-sync';

/**
 * The tab's pointer to the assistant conversation and the reply that is still running (W05 FR-055, FR-071, AS-48, AS-50). The
 * only module of this capability that touches `sessionStorage`. It keeps conversation id, the running reply's message id, the
 * one pending question and its `Idempotency-Key`, plus a "sheet was open" flag; never a token, never a location, never any
 * other text. Both keys are listed in `lib/browser-storage-keys.ts` and on the privacy page. They are removed when the reply
 * ends, when the conversation is deleted and at sign-out. Storage that throws acts like no storage.
 */
export const ACTIVE_KEY = 'assistant.active';
export const SHEET_OPEN_KEY = 'assistant.sheetOpen';

const pointerSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  pendingText: z.string().optional(),
  idempotencyKey: z.string().min(1).optional(),
});
export type ActivePointer = z.infer<typeof pointerSchema>;

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    // Quota or private mode: the pointer just does not survive a reload.
  }
}

function remove(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

export function loadActive(): ActivePointer | null {
  const raw = read(ACTIVE_KEY);
  if (raw === null) return null;
  try {
    const parsed = pointerSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // damaged value: removed below
  }
  remove(ACTIVE_KEY);
  return null;
}

/** Stores the four known fields and nothing else, whatever the caller passes. */
export function saveActive(pointer: ActivePointer): void {
  const { conversationId, messageId, pendingText, idempotencyKey } = pointer;
  write(ACTIVE_KEY, JSON.stringify({ conversationId, ...(messageId ? { messageId } : {}), ...(pendingText ? { pendingText } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) }));
}

export function clearActive(): void {
  remove(ACTIVE_KEY);
}

/** The reply ended: the running reply, the pending question and the key go; the conversation stays. */
export function clearReply(): void {
  const pointer = loadActive();
  if (pointer) saveActive({ conversationId: pointer.conversationId });
}

/** The conversation was deleted: the pointer goes when it points at it. */
export function clearForConversation(conversationId: string): void {
  if (loadActive()?.conversationId === conversationId) clearActive();
}

export function loadSheetOpen(): boolean {
  return read(SHEET_OPEN_KEY) === '1';
}

/** `false` removes the key instead of storing a value. */
export function saveSheetOpen(open: boolean): void {
  if (open) write(SHEET_OPEN_KEY, '1');
  else remove(SHEET_OPEN_KEY);
}

/** Sign-out: the pointer and the flag are deleted; nothing else the tab stores is touched. */
export function clearAssistantStorage(): void {
  remove(ACTIVE_KEY);
  remove(SHEET_OPEN_KEY);
}

/** Listens for the `auth` broadcast and clears everything on "signed-out". Returns the unsubscribe function. */
export function watchAuthForAssistant(): () => void {
  return subscribeAuth((type) => {
    if (type === 'signed-out') clearAssistantStorage();
  });
}
