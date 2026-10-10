import { canManage, canLeave } from './role-policy';
import type { ShopRole } from './shop-types';

const ROLES: ShopRole[] = ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'];

/** actor -> roles the actor may touch (current role) and hand out (new role). */
const MANAGES: Record<ShopRole, ShopRole[]> = {
  OWNER: ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'],
  ADMIN: ['STAFF', 'VIEWER'],
  STAFF: [],
  VIEWER: [],
};

const CASES = ROLES.flatMap((actor) =>
  ROLES.flatMap((target) =>
    ROLES.map(
      (next) =>
        [
          actor,
          target,
          next,
          MANAGES[actor].includes(target) && MANAGES[actor].includes(next),
        ] as const,
    ),
  ),
);

describe('S03 AS-18 canManage', () => {
  it.each(CASES)(
    'actor %s on a %s member moving to %s -> %s',
    (actor, target, next, expected) => {
      expect(canManage(actor, target, next)).toBe(expected);
    },
  );

  it.each(ROLES.flatMap((actor) => ROLES.map((t) => [actor, t] as const)))(
    'removal: actor %s of a %s member follows the target rule',
    (actor, target) => {
      expect(canManage(actor, target)).toBe(MANAGES[actor].includes(target));
    },
  );

  it.each(ROLES)('every role may leave on its own (%s)', (role) => {
    expect(canLeave(role)).toBe(true);
  });
});
