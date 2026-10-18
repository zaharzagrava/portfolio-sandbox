import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canSend, codePointLength, composerState, counterView, cutToLimit, msUntilReEnabled, shouldSendOnKey, trimmedBody } from './composer-rules';

const key = (init: { key?: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }) => ({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, ...init });

describe('Composer rules', () => {
  it('W05 AS-15 UC5: Enter sends, Shift+Enter inserts a newline, Enter during IME composition never sends', () => {
    const table: [string, ReturnType<typeof key>, boolean][] = [
      ['Enter', key({}), true],
      ['Shift+Enter', key({ shiftKey: true }), false],
      ['Enter while composing (isComposing)', key({ isComposing: true }), false],
      ['Enter with the IME keyCode 229', key({ keyCode: 229 }), false],
      ['another key', key({ key: 'a', keyCode: 65 }), false],
      ['Escape', key({ key: 'Escape', keyCode: 27 }), false],
    ];
    for (const [name, event, expected] of table) expect(shouldSendOnKey(event), name).toBe(expected);
  });

  it('W05 AS-15 UC5: the draft is trimmed before sending and a whitespace-only draft cannot be sent', () => {
    expect(trimmedBody('  hello \n')).toBe('hello');
    expect(canSend('   \n\t ', { enabled: true, sending: false })).toBe(false);
    expect(canSend('', { enabled: true, sending: false })).toBe(false);
    expect(canSend(' x ', { enabled: true, sending: false })).toBe(true);
  });

  it('W05 AS-15 UC5: sending is off while the composer is disabled and never twice for the draft that is in flight', () => {
    expect(canSend('hello', { enabled: false, sending: false })).toBe(false);
    expect(canSend('hello', { enabled: true, sending: true })).toBe(false);
  });

  it('W05 AS-15 UC5: the length is counted in Unicode code points, not UTF-16 units', () => {
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength('😀😀')).toBe(2);
    expect('😀'.length).toBe(2);
    expect(codePointLength('a😀é')).toBe(3);
  });

  it('W05 AS-15 UC5: typing or pasting past 4,000 code points is cut at the limit, never inside a pair', () => {
    const long = 'x'.repeat(3998) + '😀😀😀';
    const cut = cutToLimit(long);
    expect(codePointLength(cut)).toBe(4000);
    expect(cut.endsWith('😀😀')).toBe(true);
    expect(cutToLimit('short')).toBe('short');
    expect(cutToLimit('😀'.repeat(5), 3)).toBe('😀😀😀');
  });

  it('W05 AS-15 UC5: the counter "{n} / 4,000" shows beyond 3,500 and announces only when it crosses 3,500 and 4,000', () => {
    expect(counterView(0)).toEqual({ visible: false, text: '', announce: false });
    expect(counterView(3500)).toEqual({ visible: false, text: '', announce: false });
    expect(counterView(3501, 3500)).toMatchObject({ visible: true, text: '3,501 / 4,000', announce: true });
    expect(counterView(3510, 3499)).toMatchObject({ visible: true, announce: true });
    expect(counterView(3600, 3599)).toMatchObject({ visible: true, announce: false });
    expect(counterView(3999, 3998)).toMatchObject({ visible: true, announce: false });
    expect(counterView(4000, 3999)).toMatchObject({ visible: true, text: '4,000 / 4,000', announce: true });
    expect(counterView(4000, 4000)).toMatchObject({ visible: true, announce: false });
    expect(counterView(3999, 4000)).toMatchObject({ visible: true, announce: false });
  });
});

describe('Composer state', () => {
  const now = Date.parse('2026-10-17T10:00:00.000Z');
  const base = { now, isArchived: false, banned: false, mutedUntil: null, loadFailed: false };

  beforeEach(() => vi.useFakeTimers({ now }));
  afterEach(() => vi.useRealTimers());

  it('W05 AS-18 UC5: an active member can type and send', () => {
    expect(composerState(base)).toEqual({ enabled: true });
  });

  it('W05 AS-18 UC5: banned replaces the composer and makes the chat read-only', () => {
    expect(composerState({ ...base, banned: true })).toEqual({ enabled: false, reason: 'banned', text: 'You can no longer take part in this chat.' });
  });

  it('W05 AS-18 UC5: archived disables the composer with a line that says the chat can still be read', () => {
    expect(composerState({ ...base, isArchived: true })).toEqual({ enabled: false, reason: 'archived', text: 'This chat was archived. You can read it, but not reply.' });
  });

  it('W05 AS-18 UC5: muted disables the composer until the instant, then it is enabled again', () => {
    const until = '2026-10-17T10:30:00.000Z';
    const muted = composerState({ ...base, mutedUntil: until });
    expect(muted).toMatchObject({ enabled: false, reason: 'muted' });
    expect(muted.text).toMatch(/^You're muted until .+\.$/);
    expect(muted.text).toContain(new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    expect(msUntilReEnabled({ ...base, mutedUntil: until })).toBe(30 * 60 * 1000);
    expect(composerState({ ...base, mutedUntil: until, now: Date.parse(until) })).toEqual({ enabled: true });
    expect(composerState({ ...base, mutedUntil: until, now: Date.parse(until) + 1 })).toEqual({ enabled: true });
    expect(msUntilReEnabled({ ...base, mutedUntil: until, now: Date.parse(until) })).toBeNull();
  });

  it('W05 AS-12 UC4: a failed load disables the composer', () => {
    expect(composerState({ ...base, loadFailed: true })).toEqual({ enabled: false, reason: 'load-failed', text: "We couldn't load this chat." });
  });

  it('W05 AS-18 UC5: when several apply, banned beats archived beats muted, and a mute that has ended is ignored', () => {
    const until = '2026-10-17T10:30:00.000Z';
    expect(composerState({ ...base, banned: true, isArchived: true, mutedUntil: until }).reason).toBe('banned');
    expect(composerState({ ...base, isArchived: true, mutedUntil: until }).reason).toBe('archived');
    expect(composerState({ ...base, mutedUntil: '2026-10-17T09:00:00.000Z' })).toEqual({ enabled: true });
    expect(composerState({ ...base, mutedUntil: 'not a date' })).toEqual({ enabled: true });
    expect(msUntilReEnabled(base)).toBeNull();
  });
});
