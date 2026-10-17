/**
 * Status machine of a listing draft (S06 FR-004). Pure: the repository turns each allowed transition into
 * `UPDATE ... WHERE id AND shopId AND status = :from [AND publishLeaseId = :lease]` and asserts one row.
 */
export const DRAFT_STATUSES = [
  'DRAFT',
  'PUBLISHING',
  'PUBLISHED',
  'ARCHIVED',
] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export type DraftTransitionResult =
  | { ok: true }
  | {
      ok: false;
      code: 'invalid_transition' | 'publish_in_progress';
      currentStatus: DraftStatus;
    };

/** from -> allowed targets. `PUBLISHING -> PUBLISHED` also needs the lease id of the claim. */
const ALLOWED: Record<DraftStatus, readonly DraftStatus[]> = {
  DRAFT: ['PUBLISHING', 'ARCHIVED'],
  PUBLISHING: ['PUBLISHED', 'DRAFT'],
  PUBLISHED: [],
  ARCHIVED: [],
};

export function applyDraftTransition(
  from: DraftStatus,
  to: DraftStatus,
  ctx: { leaseId?: string | null } = {},
): DraftTransitionResult {
  if (from === 'PUBLISHING' && (to === 'ARCHIVED' || to === 'PUBLISHING'))
    return { ok: false, code: 'publish_in_progress', currentStatus: from };
  if (!ALLOWED[from].includes(to))
    return { ok: false, code: 'invalid_transition', currentStatus: from };
  if (from === 'PUBLISHING' && to === 'PUBLISHED' && !ctx.leaseId)
    return { ok: false, code: 'invalid_transition', currentStatus: from };
  return { ok: true };
}
