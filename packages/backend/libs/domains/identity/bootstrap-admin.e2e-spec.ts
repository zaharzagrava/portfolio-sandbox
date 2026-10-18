import { getModelToken } from '@nestjs/sequelize';
import { ApiConfigService } from '@app/common/config';
import { BootstrapAdminService } from './application/bootstrap-admin.service';
import User from './infra/models/user.model';
import { AuthTestApp, createAuthApp } from './testing/auth-app';

describe('Bootstrap administrator (local profile)', () => {
  let t: AuthTestApp;
  let users: typeof User;
  let service: BootstrapAdminService;

  const configure = (values: Record<string, string | undefined>) =>
    jest
      .spyOn(t.app.get(ApiConfigService), 'get')
      .mockImplementation(((key: string) => values[key]) as never);

  beforeAll(async () => {
    t = await createAuthApp();
    users = t.app.get(getModelToken(User));
    service = t.app.get(BootstrapAdminService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    jest.restoreAllMocks();
  });

  it('S01 G-02: the configured address becomes an ADMIN who can sign in', async () => {
    configure({
      bootstrap_admin_email: ' Boot@Example.COM ',
      bootstrap_admin_password: 'a-long-bootstrap-password',
    });

    expect(await service.provision()).toBe(true);

    const rows = await users.findAll({
      where: { email: 'boot@example.com' },
      raw: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('ADMIN');
    jest.restoreAllMocks();
    const login = await t
      .http()
      .post('/api/auth/login')
      .send({
        email: 'boot@example.com',
        password: 'a-long-bootstrap-password',
      })
      .expect(200);
    expect(login.body.user.role).toBe('ADMIN');
  });

  it('S01 G-02: provisioning twice leaves one account (idempotent)', async () => {
    configure({
      bootstrap_admin_email: 'twice@example.com',
      bootstrap_admin_password: 'a-long-bootstrap-password',
    });
    expect(await service.provision()).toBe(true);
    expect(await service.provision()).toBe(false);
    expect(await users.count({ where: { email: 'twice@example.com' } })).toBe(
      1,
    );
  });

  it('S01 G-02: nothing is created when the settings are absent', async () => {
    configure({});
    expect(await service.provision()).toBe(false);
  });

  it('S01 G-02: an existing account with that address is left alone', async () => {
    const existing = await t.seedUser({ email: 'owner@example.com' });
    configure({
      bootstrap_admin_email: 'owner@example.com',
      bootstrap_admin_password: 'a-long-bootstrap-password',
    });
    expect(await service.provision()).toBe(false);
    const row = await users.findByPk(existing.id, { raw: true });
    expect(row?.role).toBe('USER');
  });
});
