import { beforeEach, describe, expect, it, vi } from 'vitest';
import { endSession, rearmSessionEnd, setSessionEndHandler } from './session-ended';

describe('session ended', () => {
  beforeEach(() => {
    rearmSessionEnd();
    setSessionEndHandler(null);
  });

  it('W01 AS-26: runs the handler once for concurrent failures until it is re-armed', () => {
    const handler = vi.fn();
    setSessionEndHandler(handler);
    endSession();
    endSession();
    endSession();
    expect(handler).toHaveBeenCalledTimes(1);
    rearmSessionEnd();
    endSession();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('W01 AS-26: does nothing without a registered handler', () => {
    expect(() => endSession()).not.toThrow();
  });
});
