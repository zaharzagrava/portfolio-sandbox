import { describe, expect, it } from 'vitest';
import { RESUME_GIVE_UP_MS, resumeOffset, resumeWait } from './resume-schedule';

describe('Resume schedule', () => {
  it('W05 AS-49 UA4: the first attempts come at 0, 1, 2, 4 and 8 seconds after the drop (all inside the server\'s 10 s grace), then every 10 seconds', () => {
    const offsets = Array.from({ length: 8 }, (_, attempt) => resumeOffset(attempt));
    expect(offsets).toEqual([0, 1000, 2000, 4000, 8000, 18_000, 28_000, 38_000]);
  });

  it('W05 AS-49 UA4: attempts continue every 10 seconds up to 2 minutes, then the schedule ends', () => {
    const all: number[] = [];
    for (let attempt = 0; resumeOffset(attempt) !== null; attempt++) all.push(resumeOffset(attempt)!);
    expect(all).toHaveLength(16);
    expect(all.at(-1)).toBe(118_000);
    expect(all.every((offset) => offset < RESUME_GIVE_UP_MS)).toBe(true);
    expect(RESUME_GIVE_UP_MS).toBe(120_000);
    expect(resumeOffset(16)).toBeNull();
    expect(resumeOffset(-1)).toBeNull();
  });

  it('W05 AS-49 UA4: the wait before an attempt is what is left of its offset, never negative', () => {
    expect(resumeWait(0, 0)).toBe(0);
    expect(resumeWait(1, 0)).toBe(1000);
    expect(resumeWait(1, 400)).toBe(600);
    expect(resumeWait(2, 5000)).toBe(0);
    expect(resumeWait(5, 8000)).toBe(10_000);
    expect(resumeWait(99, 0)).toBeNull();
  });
});
