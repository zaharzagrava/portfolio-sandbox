import { afterEach, describe, expect, it } from 'vitest';
import { isDraftDirty, sessionEndedDescription, setDraftDirty } from './dirty';

afterEach(() => setDraftDirty(false));

describe('dirty draft flag', () => {
  it('W06 AS-49: the session-ended toast names the lost edits only while the draft is dirty', () => {
    expect(sessionEndedDescription()).toBeUndefined();
    setDraftDirty(true);
    expect(isDraftDirty()).toBe(true);
    expect(sessionEndedDescription()).toBe('Your unsaved edits are lost. Copy them first if you need them.');
    setDraftDirty(false);
    expect(sessionEndedDescription()).toBeUndefined();
  });
});
