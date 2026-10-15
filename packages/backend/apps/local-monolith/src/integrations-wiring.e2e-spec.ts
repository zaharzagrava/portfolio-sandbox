import { MODULE_METADATA } from '@nestjs/common/constants';
import {
  IntegrationsModule,
  IntegrationsProjectorModule,
  IntegrationsWorkerModule,
} from '@app/domains/catalog-sync';
import { CoreModule } from '@app/core/core.module';
import { ProjectorModule } from '@app/projector/projector.module';
import { WorkerModule } from '@app/worker/worker.module';
import { LocalMonolithModule } from './local-monolith.module';

type ModuleRef = object | { module: object; imports?: unknown[] };

const classOf = (ref: ModuleRef): object =>
  'module' in ref ? (ref as { module: object }).module : ref;

/** Every module class reachable through `imports` (static and dynamic modules). */
function reachable(root: object): Set<object> {
  const classes = new Set<object>();
  const visited = new Set<object>(); // dynamic modules of one class (`forFeature(...)`) are different objects
  const visit = (ref: ModuleRef | undefined) => {
    if (!ref || (typeof ref !== 'object' && typeof ref !== 'function')) return;
    if (visited.has(ref)) return;
    visited.add(ref);
    const module = classOf(ref);
    classes.add(module);
    const own = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) ??
      []) as ModuleRef[];
    const dynamic = (
      'module' in ref ? ((ref as { imports?: ModuleRef[] }).imports ?? []) : []
    ) as ModuleRef[];
    for (const child of [...own, ...dynamic]) visit(child);
  };
  visit(root);
  return classes;
}

/**
 * Which application hosts which module of the integrations (S08 AS-80, T040): the webhook, OAuth callback and
 * management routes in core, the queue consumers and jobs in the worker, the event consumers in the projector, and all of
 * them in the monolith, which hosts the applications. Booting each application is proven by the sibling wiring specs.
 */
describe('Integrations module placement across the applications', () => {
  it('S08 AS-80: core hosts IntegrationsModule only, the worker IntegrationsWorkerModule only, the projector IntegrationsProjectorModule only', () => {
    const core = reachable(CoreModule);
    expect(core.has(IntegrationsModule)).toBe(true);
    expect(core.has(IntegrationsWorkerModule)).toBe(false);
    expect(core.has(IntegrationsProjectorModule)).toBe(false);

    const worker = reachable(WorkerModule);
    expect(worker.has(IntegrationsWorkerModule)).toBe(true);
    expect(worker.has(IntegrationsModule)).toBe(false);
    expect(worker.has(IntegrationsProjectorModule)).toBe(false);

    const projector = reachable(ProjectorModule);
    expect(projector.has(IntegrationsProjectorModule)).toBe(true);
    expect(projector.has(IntegrationsModule)).toBe(false);
    expect(projector.has(IntegrationsWorkerModule)).toBe(false);
  });

  it('S08 AS-80: the module lists every consumer of the capability for the projector application', () => {
    expect(IntegrationsProjectorModule.projectors.map((p) => p.name)).toEqual([
      'ProductEventsConsumer',
      'TenancyOffboardingConsumer',
      'TenancyShopDeletedConsumer',
    ]);
  });

  it('S08 AS-80: the monolith hosts all three integration modules through the applications', () => {
    const monolith = reachable(LocalMonolithModule);
    expect(monolith.has(IntegrationsModule)).toBe(true);
    expect(monolith.has(IntegrationsWorkerModule)).toBe(true);
    expect(monolith.has(IntegrationsProjectorModule)).toBe(true);
  });
});
