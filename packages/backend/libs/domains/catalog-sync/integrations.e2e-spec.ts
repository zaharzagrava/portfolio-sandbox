import { PATH_METADATA } from '@nestjs/common/constants';
import { ConflictController } from './api/conflict.controller';
import { IntegrationOAuthController } from './api/integration-oauth.controller';
import { IntegrationWebhookController } from './api/integration-webhook.controller';
import { IntegrationsController } from './api/integrations.controller';
import { QuarantineController } from './api/quarantine.controller';
import { ReconcileController } from './api/reconcile.controller';
import { IntegrationsModule } from './integrations.module';

/**
 * Replaces the first-generation sync spec, which drove the deleted fake provider and `IntegrationSyncService`
 * (S08 gate repair, L-017). Its behaviors are now proven by `integration-sync`, `-stock`, `-webhooks`, `-reconcile` and
 * `-quarantine`; this file keeps the scenario of the routes the core application mounts, so a controller dropped from
 * the module or moved to another path fails here before it fails in a deployed app.
 */
const mounted = (): Array<new (...a: never[]) => unknown> =>
  Reflect.getMetadata('controllers', IntegrationsModule) ?? [];
const pathOf = (c: object): unknown => Reflect.getMetadata(PATH_METADATA, c);

describe('Integrations module routes (e2e)', () => {
  it('S08 AS-02: the core module mounts exactly the six integration controllers', () => {
    const names = mounted()
      .map((c) => c.name)
      .sort();
    expect(names).toHaveLength(6);
    expect(names).toContain('IntegrationsController');
    expect(names).toContain('ReconcileController');
  });

  it('S08 AS-02: IntegrationsController (connect and manage routes) is mounted under shops/:shopId/integrations', () => {
    expect(mounted()).toContain(IntegrationsController);
    expect(pathOf(IntegrationsController)).toBe('shops/:shopId/integrations');
    expect(typeof IntegrationsController).toBe('function');
    expect(
      Object.getOwnPropertyNames(IntegrationsController.prototype).length,
    ).toBeGreaterThan(1);
  });

  it('S08 AS-03: IntegrationOAuthController (anonymous OAuth callback) is mounted under integrations/shopify', () => {
    expect(mounted()).toContain(IntegrationOAuthController);
    expect(pathOf(IntegrationOAuthController)).toBe('integrations/shopify');
    expect(typeof IntegrationOAuthController).toBe('function');
    expect(
      Object.getOwnPropertyNames(IntegrationOAuthController.prototype).length,
    ).toBeGreaterThan(1);
  });

  it('S08 AS-26: IntegrationWebhookController (webhook route) is mounted under integrations/:integrationId/webhooks', () => {
    expect(mounted()).toContain(IntegrationWebhookController);
    expect(pathOf(IntegrationWebhookController)).toBe(
      'integrations/:integrationId/webhooks',
    );
    expect(typeof IntegrationWebhookController).toBe('function');
    expect(
      Object.getOwnPropertyNames(IntegrationWebhookController.prototype).length,
    ).toBeGreaterThan(1);
  });

  it('S08 AS-39: ConflictController (conflict routes) is mounted under the integration conflicts path', () => {
    expect(mounted()).toContain(ConflictController);
    expect(pathOf(ConflictController)).toBe(
      'shops/:shopId/integrations/:integrationId/conflicts',
    );
    expect(typeof ConflictController).toBe('function');
    expect(
      Object.getOwnPropertyNames(ConflictController.prototype).length,
    ).toBeGreaterThan(1);
  });

  it('S08 AS-50: QuarantineController (quarantine routes) is mounted under the integration quarantine path', () => {
    expect(mounted()).toContain(QuarantineController);
    expect(pathOf(QuarantineController)).toBe(
      'shops/:shopId/integrations/:integrationId/quarantine',
    );
    expect(typeof QuarantineController).toBe('function');
    expect(
      Object.getOwnPropertyNames(QuarantineController.prototype).length,
    ).toBeGreaterThan(1);
  });

  it('S08 AS-65: ReconcileController (reconcile routes) is mounted under the integration path', () => {
    expect(mounted()).toContain(ReconcileController);
    expect(pathOf(ReconcileController)).toBe(
      'shops/:shopId/integrations/:integrationId',
    );
    expect(typeof ReconcileController).toBe('function');
    expect(
      Object.getOwnPropertyNames(ReconcileController.prototype).length,
    ).toBeGreaterThan(1);
  });

  it('S08 AS-27: the webhook and OAuth routes are anonymous by integration id, never nested under a shop', () => {
    expect(pathOf(IntegrationWebhookController)).not.toContain(':shopId');
    expect(pathOf(IntegrationWebhookController)).toContain(':integrationId');
    expect(pathOf(IntegrationOAuthController)).not.toContain(':shopId');
  });
});
