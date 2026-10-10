import { getModelToken } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v4 } from 'uuid';
import { AuthTestApp, createAuthApp } from './testing/auth-app';
import {
  TooManyIdsError,
  UserDirectoryService,
  USER_DIRECTORY_MAX_IDS,
} from './application/user-directory.service';
import User from './infra/models/user.model';

describe('User directory', () => {
  let t: AuthTestApp;
  let directory: UserDirectoryService;

  beforeAll(async () => {
    t = await createAuthApp();
    directory = t.app.get(UserDirectoryService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('S01 AS-79: getUsersByIds returns summaries for the known, live users in one read', async () => {
    const a = await t.seedUser({ email: 'a@example.com' });
    const b = await t.seedUser({
      email: 'b@example.com',
      role: 'SELLER' as never,
    });
    const gone = await t.seedUser({ email: 'gone@example.com' });
    await t.app
      .get<typeof User>(getModelToken(User))
      .destroy({ where: { id: gone.id } });
    const queries: string[] = [];
    t.app.get(Sequelize).options.logging = (sql: string) =>
      void queries.push(sql);

    const found = await directory.getUsersByIds([
      a.id,
      b.id,
      gone.id,
      v4(),
      a.id,
    ]);
    t.app.get(Sequelize).options.logging = false;

    expect([...found.keys()].sort()).toEqual([a.id, b.id].sort());
    expect(found.get(a.id)).toEqual({
      id: a.id,
      email: 'a@example.com',
      role: 'USER',
      createdAt: expect.any(Date),
    });
    expect(Object.keys(found.get(b.id)!).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'role',
    ]);
    expect(queries.filter((q) => /FROM "User"/.test(q))).toHaveLength(1);
  });

  it('S01 AS-79: more than 500 ids is TooManyIds', async () => {
    const ids = Array.from({ length: USER_DIRECTORY_MAX_IDS + 1 }, () => v4());
    await expect(directory.getUsersByIds(ids)).rejects.toBeInstanceOf(
      TooManyIdsError,
    );
    await expect(
      directory.getUsersByIds(ids.slice(0, USER_DIRECTORY_MAX_IDS)),
    ).resolves.toEqual(new Map());
  });

  it('S01 AS-80: findByEmail trims and lower-cases, and is null for an unknown address', async () => {
    const user = await t.seedUser({ email: 'find.me@example.com' });
    expect((await directory.findByEmail('  Find.Me@EXAMPLE.com '))?.id).toBe(
      user.id,
    );
    expect(await directory.findByEmail('nobody@example.com')).toBeNull();
  });
});
