/**
 * Whether the open flag editor holds unsaved edits (W06 AS-49, R-07). Module-level on purpose: W01's session-ended flow runs
 * outside React and needs one boolean, never the draft itself (no flag data leaves the editor, AS-56).
 */
let dirty = false;

export const setDraftDirty = (value: boolean): void => {
  dirty = value;
};
export const isDraftDirty = (): boolean => dirty;

export const DIRTY_SENTENCE = 'Your unsaved edits are lost. Copy them first if you need them.';

/** The description line of the session-ended toast: present only while the draft is dirty. */
export const sessionEndedDescription = (): string | undefined => (dirty ? DIRTY_SENTENCE : undefined);
