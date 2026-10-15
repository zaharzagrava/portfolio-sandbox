import { Inject, Injectable } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import type {
  SyncConflict,
  SyncConflictPage,
} from '@marketplace-sandbox/contracts';
import { AppError, ErrorArea, PlatformCodes } from '@app/common/errors';
import { syncProblem } from '../domain/catalog-sync-errors';
import {
  SYNC_CLOCK,
  SYNC_CONFLICT_REPOSITORY,
  type Clock,
  type SyncConflictRecord,
  type SyncConflictRepository,
  type SyncConflictStatus,
} from '../domain/ports';

const notFound = () =>
  new AppError({
    status: HttpStatus.NOT_FOUND,
    code: PlatformCodes.not_found,
    title: 'Not Found',
    detail: 'The resource was not found.',
    area: ErrorArea.DOMAIN,
  });

const view = (c: SyncConflictRecord): SyncConflict => ({
  opId: c.opId,
  deviceId: c.deviceId,
  productId: c.productId,
  kind: c.kind,
  requested: c.requested,
  applied: c.applied,
  shortfall: c.shortfall,
  quantityAfter: c.quantityAfter,
  status: c.status,
  createdAt: c.createdAt.toISOString(),
  ...(c.dismissedAt ? { dismissedAt: c.dismissedAt.toISOString() } : {}),
  ...(c.dismissedBy ? { dismissedBy: c.dismissedBy } : {}),
});

/** Review of the cases a machine cannot settle (FR-031): list newest first, dismiss an open one exactly once. */
@Injectable()
export class SyncConflictService {
  constructor(
    @Inject(SYNC_CONFLICT_REPOSITORY)
    private readonly conflicts: SyncConflictRepository,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
  ) {}

  async list(
    shopId: string,
    query: { status: SyncConflictStatus; limit: number; cursor?: string },
  ): Promise<SyncConflictPage> {
    const page = await this.conflicts.page(shopId, query);
    return { items: page.items.map(view), nextCursor: page.nextCursor };
  }

  async dismiss(
    shopId: string,
    opId: string,
    actorId: string,
  ): Promise<SyncConflict> {
    const dismissed = await this.conflicts.dismiss(
      shopId,
      opId,
      actorId,
      this.clock.now(),
    );
    if (dismissed) return view(dismissed);
    // Not dismissed: either it is not this shop's (indistinguishable from unknown) or it was not open any more.
    if (!(await this.conflicts.find(shopId, opId))) throw notFound();
    throw syncProblem('conflict_not_open');
  }
}
