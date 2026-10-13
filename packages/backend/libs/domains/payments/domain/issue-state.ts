export const ISSUE_STATES = ['OPEN', 'RESOLVED'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export const RESOLUTIONS = ['explained', 'adjusted', 'auto_matched'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** `OPEN -> RESOLVED(resolution)` is the only move; a resolved issue never changes (FR-040). */
export function resolveIssue(
  state: IssueState,
  resolution: Resolution,
): { status: 'RESOLVED'; resolution: Resolution } {
  if (!RESOLUTIONS.includes(resolution))
    throw new Error(`unknown resolution ${String(resolution)}`);
  if (state !== 'OPEN') throw new Error(`illegal issue transition ${state}`);
  return { status: 'RESOLVED', resolution };
}
