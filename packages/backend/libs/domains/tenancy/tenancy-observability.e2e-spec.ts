import { Logger } from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import {
  addMember,
  createInvite,
  createShop,
} from '@app/test/utils/tenancy-fixtures';
import { ShopProvisioningService } from './application/shop-provisioning.service';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

const TENANCY_METRICS = [
  'tenancy_cross_tenant_total',
  'tenancy_authz_denied_total',
  'tenancy_authz_cache_total',
  'tenancy_serialization_retries_total',
  'tenancy_provisioned_total',
];

describe('Observability of the tenancy domain', () => {
  let t: TenancyTestApp;

  beforeAll(async () => {
    t = await createTenancyApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('S03 AS-81: each mutation writes one audit line with actor, shop, action and request, and no address, token or secret', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const all: string[] = [];
    const capture = (...args: unknown[]) => {
      all.push(JSON.stringify(args));
      const first = args[0];
      if (first && typeof first === 'object' && 'action' in first)
        lines.push(first as Record<string, unknown>);
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(capture);

    const owner = await t.newUser();
    const invitee = await t.newUser();
    const staff = await t.newUser();
    const created = await t
      .as(owner)
      .post('/api/shops')
      .send({ name: 'Audited', slug: 'audited-shop' })
      .expect(201);
    const shopId = created.body.id as string;
    await addMember(t.app, shopId, staff.id, 'STAFF');
    await t
      .as(owner)
      .patch(`/api/shops/${shopId}`)
      .send({ name: 'Audited 2' })
      .expect(200);
    await t
      .as(owner)
      .patch(`/api/shops/${shopId}/members/${staff.id}`)
      .send({ role: 'ADMIN' })
      .expect(204);
    await t
      .as(owner)
      .post(`/api/shops/${shopId}/invites`)
      .send({ email: invitee.email, role: 'VIEWER' })
      .expect(201);
    const task = (await outboxRowsFor(t.app, shopId)).find(
      (e) => e.kind === 'task',
    )!;
    const body = (task.payload as { body: { token: string; inviteId: string } })
      .body;
    await t
      .as(owner)
      .post(`/api/shops/${shopId}/invites/${body.inviteId}/resend`)
      .expect(200);
    const resent = (await outboxRowsFor(t.app, shopId))
      .filter((e) => e.kind === 'task')
      .pop()!;
    const resentToken = (resent.payload as { body: { token: string } }).body
      .token;
    await t
      .as(invitee)
      .post('/api/shop-invites/accept')
      .send({ token: resentToken })
      .expect(201);
    await t
      .as(owner)
      .delete(`/api/shops/${shopId}/members/${staff.id}`)
      .expect(204);
    const other = await createInvite(t.app, shopId, {
      email: 'x@example.com',
      invitedBy: owner.id,
    });
    await t
      .as(owner)
      .delete(`/api/shops/${shopId}/invites/${other.invite.id}`)
      .expect(204);
    jest.restoreAllMocks();

    expect(lines.map((l) => l.action)).toEqual([
      'shop.created',
      'shop.updated',
      'member.role_changed',
      'invite.created',
      'invite.resent',
      'invite.accepted',
      'member.removed',
      'invite.revoked',
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({
        shopId,
        actorId: expect.any(String),
        requestId: expect.any(String),
      });
    }
    const text = all.join('\n');
    for (const secret of [
      owner.email,
      invitee.email,
      staff.email,
      body.token,
      resentToken,
    ])
      expect(text.includes(secret) ? secret : null).toBeNull();
  });

  it('S03 AS-81: counters exist for denials, bypasses, cache lookups and provisioning, and no label is a shop or a user', async () => {
    const owner = await t.newUser();
    const stranger = await t.newUser();
    const seller = await t.newUser();
    const shop = await createShop(t.app, owner);
    const before = (name: string, labels: Record<string, string>) =>
      MetricsRegistry.value(name, labels) ?? 0;
    const denied = before('tenancy_authz_denied_total', {
      reason: 'not_member',
    });
    const provisioned = before('tenancy_provisioned_total', {
      outcome: 'legacy_created',
    });
    const bypass = before('tenancy_cross_tenant_total', {
      reason: 'legacy.provision',
    });

    await t.as(stranger).get(`/api/shops/${shop.id}`).expect(404);
    await t.as(owner).get(`/api/shops/${shop.id}`).expect(200);
    await t.app
      .get(ShopProvisioningService)
      .ensureShopsForLegacySellers([seller.id]);

    expect(before('tenancy_authz_denied_total', { reason: 'not_member' })).toBe(
      denied + 1,
    );
    expect(
      before('tenancy_provisioned_total', { outcome: 'legacy_created' }),
    ).toBe(provisioned + 1);
    expect(
      before('tenancy_cross_tenant_total', { reason: 'legacy.provision' }),
    ).toBe(bypass + 1);
    expect(
      MetricsRegistry.value('tenancy_authz_cache_total', { result: 'miss' }),
    ).toBeGreaterThan(0);

    for (const metric of TENANCY_METRICS)
      for (const labels of MetricsRegistry.labelSets(metric))
        for (const key of Object.keys(labels)) {
          expect(['reason', 'result', 'outcome', 'overflow']).toContain(key);
          for (const value of Object.values(labels))
            expect(String(value)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
        }
  });
});
