import { MODULE_METADATA } from '@nestjs/common/constants';
import {
  OfflineSyncModule,
  OfflineSyncProjectorModule,
  OfflineSyncWorkerModule,
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
  const visited = new Set<object>();
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
 * Which application hosts which module of offline sync (S09 D-8): the routes in core, the jobs in the worker, the
 * consumers in the projector, and all of them in the monolith, which hosts the applications.
 */
describe('Offline sync module placement across the applications', () => {
  it('S09 AS-53: core hosts OfflineSyncModule only, the worker the worker module only, the projector the projector module only', () => {
    const core = reachable(CoreModule);
    expect(core.has(OfflineSyncModule)).toBe(true);
    expect(core.has(OfflineSyncWorkerModule)).toBe(false);
    expect(core.has(OfflineSyncProjectorModule)).toBe(false);

    const worker = reachable(WorkerModule);
    expect(worker.has(OfflineSyncWorkerModule)).toBe(true);
    expect(worker.has(OfflineSyncModule)).toBe(false);
    expect(worker.has(OfflineSyncProjectorModule)).toBe(false);

    const projector = reachable(ProjectorModule);
    expect(projector.has(OfflineSyncProjectorModule)).toBe(true);
    expect(projector.has(OfflineSyncModule)).toBe(false);
    expect(projector.has(OfflineSyncWorkerModule)).toBe(false);
  });

  it('S09 AS-53: the module lists the three consumers for the projector application', () => {
    expect(OfflineSyncProjectorModule.projectors.map((p) => p.name)).toEqual([
      'SyncFeedConsumer',
      'OfflineProductDeletedConsumer',
      'OfflineShopDeletedConsumer',
    ]);
  });

  it('S09 AS-53: the monolith hosts all three modules through the applications', () => {
    const monolith = reachable(LocalMonolithModule);
    expect(monolith.has(OfflineSyncModule)).toBe(true);
    expect(monolith.has(OfflineSyncWorkerModule)).toBe(true);
    expect(monolith.has(OfflineSyncProjectorModule)).toBe(true);
  });
});
