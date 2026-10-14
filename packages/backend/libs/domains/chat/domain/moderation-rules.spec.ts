import {
  canActOn,
  memberTransition,
  type ActorRank,
  type MemberState,
  type ModerationAction,
} from './moderation-rules';

const NOW = new Date('2030-01-01T10:00:00.000Z');
const state = (over: Partial<MemberState> = {}): MemberState => ({
  role: 'MEMBER',
  status: 'ACTIVE',
  mutedUntil: null,
  ...over,
});

describe('S24 moderation rules', () => {
  describe('strictly higher rank', () => {
    const ranks: ActorRank[] = ['STAFF', 'OWNER', 'MODERATOR', 'MEMBER'];
    it.each([
      ['STAFF', 'OWNER', true],
      ['STAFF', 'MODERATOR', true],
      ['STAFF', 'MEMBER', true],
      ['STAFF', 'STAFF', false],
      ['MODERATOR', 'MEMBER', true],
      ['MODERATOR', 'MODERATOR', false],
      ['MODERATOR', 'STAFF', false],
      ['MODERATOR', 'OWNER', false],
      ['OWNER', 'MEMBER', false],
      ['MEMBER', 'MEMBER', false],
      ['MEMBER', 'STAFF', false],
    ] as const)(
      'S24 AS-50: %s acting on %s is %s',
      (actor, target, allowed) => {
        expect(canActOn({ actor, target, self: false })).toBe(allowed);
      },
    );

    it('S24 AS-50: nobody acts on themselves', () => {
      for (const r of ranks)
        expect(canActOn({ actor: r, target: 'MEMBER', self: true })).toBe(
          false,
        );
    });

    it('S24 AS-50: a stored OWNER confers no authority by itself', () => {
      for (const t of ranks)
        expect(canActOn({ actor: 'OWNER', target: t, self: false })).toBe(
          false,
        );
    });
  });

  describe('status and role transitions', () => {
    it.each([
      ['ban', state(), { ok: true, next: state({ status: 'BANNED' }) }],
      ['ban', state({ status: 'BANNED' }), { ok: false }],
      ['unban', state({ status: 'BANNED' }), { ok: true, next: state() }],
      ['unban', state(), { ok: false }],
    ] as const)('S24 AS-49: %s on %j', (action, from, expected) => {
      expect(
        memberTransition(action as ModerationAction, from, NOW, undefined),
      ).toEqual(expected);
    });

    it('S24 AS-51: mute sets and replaces mutedUntil from now; unmute needs an active mute', () => {
      const muted = memberTransition('mute', state(), NOW, 10);
      expect(muted).toEqual({
        ok: true,
        next: state({ mutedUntil: new Date('2030-01-01T10:10:00.000Z') }),
      });
      const again = memberTransition(
        'mute',
        (muted as { next: MemberState }).next,
        NOW,
        60,
      );
      expect(again).toEqual({
        ok: true,
        next: state({ mutedUntil: new Date('2030-01-01T11:00:00.000Z') }),
      });
      expect(
        memberTransition(
          'unmute',
          (again as { next: MemberState }).next,
          NOW,
          undefined,
        ),
      ).toEqual({
        ok: true,
        next: state(),
      });
      expect(memberTransition('unmute', state(), NOW, undefined)).toEqual({
        ok: false,
      });
      expect(
        memberTransition(
          'unmute',
          state({ mutedUntil: new Date('2029-12-31T00:00:00Z') }),
          NOW,
          undefined,
        ),
      ).toEqual({
        ok: false,
      });
    });

    it.each([
      ['promote', state(), { ok: true, next: state({ role: 'MODERATOR' }) }],
      ['promote', state({ role: 'MODERATOR' }), { ok: false }],
      ['demote', state({ role: 'MODERATOR' }), { ok: true, next: state() }],
      ['demote', state(), { ok: false }],
    ] as const)('S24 AS-52: %s on %j', (action, from, expected) => {
      expect(
        memberTransition(action as ModerationAction, from, NOW, undefined),
      ).toEqual(expected);
    });

    it('S24 AS-52: the OWNER role is never changed by an action', () => {
      for (const a of ['promote', 'demote'] as const) {
        expect(
          memberTransition(a, state({ role: 'OWNER' }), NOW, undefined),
        ).toEqual({ ok: false });
      }
    });
  });
});
