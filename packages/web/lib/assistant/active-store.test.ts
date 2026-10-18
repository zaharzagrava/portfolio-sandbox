import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let authHandler: ((type: 'signed-in' | 'signed-out') => void) | undefined;
const unsubscribe = vi.fn();
vi.mock('@/lib/auth/session-sync', () => ({
  subscribeAuth: (handler: typeof authHandler) => {
    authHandler = handler;
    return unsubscribe;
  },
}));

import { browserStorageKeys } from '@/lib/browser-storage-keys';
import {
  ACTIVE_KEY,
  SHEET_OPEN_KEY,
  clearActive,
  clearAssistantStorage,
  clearForConversation,
  clearReply,
  loadActive,
  loadSheetOpen,
  saveActive,
  saveSheetOpen,
  watchAuthForAssistant,
} from './active-store';

const CONVERSATION = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

beforeEach(() => {
  sessionStorage.clear();
  authHandler = undefined;
  unsubscribe.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('Assistant active store', () => {
  it('W05 FR-071 AS-67 UA4: the two keys are the ones registered for the privacy page, both in session storage', () => {
    expect(ACTIVE_KEY).toBe('assistant.active');
    expect(SHEET_OPEN_KEY).toBe('assistant.sheetOpen');
    for (const key of [ACTIVE_KEY, SHEET_OPEN_KEY]) expect(browserStorageKeys.find((entry) => entry.key === key)?.store).toBe('sessionStorage');
  });

  it('W05 AS-48 AS-50 UA4: the pointer (conversation, running reply, pending question, key) survives a round trip in this tab\'s storage', () => {
    expect(loadActive()).toBeNull();
    saveActive({ conversationId: CONVERSATION, messageId: 'm1', pendingText: 'find a lamp', idempotencyKey: 'key-1' });
    expect(loadActive()).toEqual({ conversationId: CONVERSATION, messageId: 'm1', pendingText: 'find a lamp', idempotencyKey: 'key-1' });
    expect(JSON.parse(sessionStorage.getItem(ACTIVE_KEY)!)).toEqual({ conversationId: CONVERSATION, messageId: 'm1', pendingText: 'find a lamp', idempotencyKey: 'key-1' });
    expect(localStorage.length).toBe(0);
  });

  it('W05 AS-55 FR-055 UA4: only the four fields are ever stored: no token, no location, nothing else, even when handed more', () => {
    saveActive({ conversationId: CONVERSATION, accessToken: 'secret', lat: 52.5, lng: 13.4, messages: ['x'] } as never);
    const raw = sessionStorage.getItem(ACTIVE_KEY)!;
    expect(JSON.parse(raw)).toEqual({ conversationId: CONVERSATION });
    expect(raw).not.toMatch(/secret|52\.5|lat|lng|messages/);
    sessionStorage.setItem(ACTIVE_KEY, JSON.stringify({ conversationId: CONVERSATION, token: 'x', lat: 1 }));
    expect(loadActive()).toEqual({ conversationId: CONVERSATION });
  });

  it('W05 AS-48 UA4: a damaged or wrong-shaped value reads as nothing and is removed', () => {
    for (const value of ['not json', '[]', '{}', JSON.stringify({ conversationId: 5 }), JSON.stringify({ conversationId: CONVERSATION, messageId: 7 }), '"x"', 'null']) {
      sessionStorage.setItem(ACTIVE_KEY, value);
      expect(loadActive(), value).toBeNull();
      expect(sessionStorage.getItem(ACTIVE_KEY), value).toBeNull();
    }
  });

  it('W05 AS-50 FR-055 UA4: when the reply ends the reply fields go (message, pending question, key) and the conversation stays', () => {
    saveActive({ conversationId: CONVERSATION, messageId: 'm1', pendingText: 'q', idempotencyKey: 'k' });
    clearReply();
    expect(loadActive()).toEqual({ conversationId: CONVERSATION });
    clearReply();
    expect(loadActive()).toEqual({ conversationId: CONVERSATION });
    clearActive();
    clearReply();
    expect(loadActive()).toBeNull();
  });

  it('W05 AS-63 UA4: deleting a conversation clears the pointer only when it points at it', () => {
    saveActive({ conversationId: CONVERSATION, messageId: 'm1' });
    clearForConversation('0190a1b2-c3d4-7e5f-8a6b-000000000000');
    expect(loadActive()?.conversationId).toBe(CONVERSATION);
    clearForConversation(CONVERSATION);
    expect(loadActive()).toBeNull();
  });

  it('W05 AS-50 UA4: the sheet-open flag is false by default, saved as true, and removed (not stored as false) when closed', () => {
    expect(loadSheetOpen()).toBe(false);
    saveSheetOpen(true);
    expect(loadSheetOpen()).toBe(true);
    saveSheetOpen(false);
    expect(sessionStorage.getItem(SHEET_OPEN_KEY)).toBeNull();
    expect(loadSheetOpen()).toBe(false);
  });

  it('W05 AS-55 UA1: sign-out clears the pointer and the flag but nothing else the tab stores', () => {
    sessionStorage.setItem('w03.attempt.checkout', 'keep');
    saveActive({ conversationId: CONVERSATION, messageId: 'm1', pendingText: 'q' });
    saveSheetOpen(true);
    clearAssistantStorage();
    expect(loadActive()).toBeNull();
    expect(loadSheetOpen()).toBe(false);
    expect(sessionStorage.getItem('w03.attempt.checkout')).toBe('keep');
  });

  it('W05 AS-55 UA1: the auth broadcast clears everything on "signed-out" only, and the watcher returns the unsubscribe', () => {
    saveActive({ conversationId: CONVERSATION, messageId: 'm1' });
    saveSheetOpen(true);
    const stop = watchAuthForAssistant();
    authHandler?.('signed-in');
    expect(loadActive()).not.toBeNull();
    authHandler?.('signed-out');
    expect(loadActive()).toBeNull();
    expect(loadSheetOpen()).toBe(false);
    expect(stop).toBe(unsubscribe);
  });

  it('W05 AS-48 UA4: storage that throws acts like no storage: nothing crashes and nothing is remembered', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => saveActive({ conversationId: CONVERSATION })).not.toThrow();
    expect(() => saveSheetOpen(true)).not.toThrow();
    expect(loadActive()).toBeNull();
    expect(loadSheetOpen()).toBe(false);
    expect(() => clearAssistantStorage()).not.toThrow();
  });
});
