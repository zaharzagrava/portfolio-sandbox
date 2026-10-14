/**
 * Moderation rules (S24 FR-031, FR-040, FR-041): who may act on whom, and which state changes are legal. Pure.
 *
 * Ranks: shop staff (live `products.write` membership) > stored OWNER > MODERATOR > MEMBER as a target. As an actor a
 * stored OWNER has no authority by itself (FR-031), so it ranks below everything it could act on.
 */
export type ActorRank = 'STAFF' | 'OWNER' | 'MODERATOR' | 'MEMBER';

const TARGET_RANK: Record<ActorRank, number> = {
  STAFF: 4,
  OWNER: 3,
  MODERATOR: 2,
  MEMBER: 1,
};
const ACTOR_AUTHORITY: Record<ActorRank, number> = {
  STAFF: 4,
  OWNER: 0,
  MODERATOR: 2,
  MEMBER: 0,
};

export function canActOn(input: {
  actor: ActorRank;
  target: ActorRank;
  self: boolean;
}): boolean {
  if (input.self) return false;
  return ACTOR_AUTHORITY[input.actor] > TARGET_RANK[input.target];
}

export type MemberRole = 'OWNER' | 'MODERATOR' | 'MEMBER';
export type MemberStatus = 'ACTIVE' | 'BANNED';
export interface MemberState {
  role: MemberRole;
  status: MemberStatus;
  mutedUntil: Date | null;
}
export type ModerationAction =
  'ban' | 'unban' | 'mute' | 'unmute' | 'promote' | 'demote';

export type TransitionResult = { ok: true; next: MemberState } | { ok: false };

const ILLEGAL: TransitionResult = { ok: false };

/** The next state of a member, or `{ok: false}` (the caller answers `409 invalid_transition`). */
export function memberTransition(
  action: ModerationAction,
  from: MemberState,
  now: Date,
  minutes: number | undefined,
): TransitionResult {
  switch (action) {
    case 'ban':
      return from.status === 'ACTIVE'
        ? { ok: true, next: { ...from, status: 'BANNED' } }
        : ILLEGAL;
    case 'unban':
      return from.status === 'BANNED'
        ? { ok: true, next: { ...from, status: 'ACTIVE' } }
        : ILLEGAL;
    case 'mute':
      if (minutes === undefined) return ILLEGAL;
      return {
        ok: true,
        next: {
          ...from,
          mutedUntil: new Date(now.getTime() + minutes * 60_000),
        },
      };
    case 'unmute':
      return from.mutedUntil && from.mutedUntil.getTime() > now.getTime()
        ? { ok: true, next: { ...from, mutedUntil: null } }
        : ILLEGAL;
    case 'promote':
      return from.role === 'MEMBER'
        ? { ok: true, next: { ...from, role: 'MODERATOR' } }
        : ILLEGAL;
    case 'demote':
      return from.role === 'MODERATOR'
        ? { ok: true, next: { ...from, role: 'MEMBER' } }
        : ILLEGAL;
  }
}
