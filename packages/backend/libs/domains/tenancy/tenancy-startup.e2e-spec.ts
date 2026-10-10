import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { FakeClock } from '@app/common/core/clock';
import { Environment } from '@app/common/types';
import { connectAs, ensureProbeRole } from '@app/test/utils/tenancy-roles';
import { TenantDbRoleCheck } from './infra/tenant-db-role.check';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

const checkFor = (connection: Sequelize, env: Environment) =>
  new TenantDbRoleCheck(
    connection,
    { get: () => env } as never,
    new FakeClock(),
  );

describe('Tenancy startup checks', () => {
  let t: TenancyTestApp;
  let admin: Sequelize;
  const connections: Sequelize[] = [];

  const as = async (
    name: string,
    options: { bypassRls?: boolean; statementTimeout?: string },
  ) => {
    await ensureProbeRole(admin, { name, ...options });
    const conn = connectAs(admin, name);
    connections.push(conn);
    return conn;
  };

  beforeAll(async () => {
    t = await createTenancyApp();
    admin = t.app.get(Sequelize);
  });
  afterAll(async () => {
    await Promise.all(connections.map((c) => c.close()));
    await t.close();
  });

  it('S03 AS-60: production refuses to start with a superuser application role', async () => {
    await expect(
      checkFor(admin, Environment.production).verify(),
    ).rejects.toThrow(/superuser|BYPASSRLS/i);
  });

  it('S03 AS-60: production refuses a role that has BYPASSRLS', async () => {
    const bypass = await as('tenancy_probe_bypass', {
      bypassRls: true,
      statementTimeout: '30s',
    });
    await expect(
      checkFor(bypass, Environment.production).verify(),
    ).rejects.toThrow(/BYPASSRLS/i);
  });

  it('III.12: production refuses a pool whose statement_timeout is unset', async () => {
    const unlimited = await as('tenancy_probe_unlimited', {});
    await expect(
      checkFor(unlimited, Environment.production).verify(),
    ).rejects.toThrow(/statement_timeout/i);
  });

  it('S03 AS-60: production starts with a plain role that has a statement timeout', async () => {
    const plain = await as('tenancy_probe_plain', { statementTimeout: '30s' });
    await expect(
      checkFor(plain, Environment.production).verify(),
    ).resolves.toBeUndefined();
  });

  it('S03 AS-60: outside production the same problems are only a warning', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await expect(
      checkFor(admin, Environment.test).verify(),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/superuser|BYPASSRLS/i),
    );
    jest.restoreAllMocks();
  });

  it('S03 AS-60: the application runs the check when the tenancy module starts', () => {
    expect(t.app.get(TenantDbRoleCheck).lastVerifiedAt).toBeInstanceOf(Date);
  });
});
