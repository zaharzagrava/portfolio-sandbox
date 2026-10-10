import { Inject, Injectable } from '@nestjs/common';
import type { ReindexRun } from '@marketplace-sandbox/contracts';
import {
  REINDEX_RUN_REPOSITORY,
  type ReindexRunRecord,
  type ReindexRunRepository,
} from '../../domain/ports';
import { InvalidCursorError, RunNotFoundError } from '../../domain/search-errors';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const toRunView = (r: ReindexRunRecord): ReindexRun => ({
  runId: r.runId,
  kind: r.kind,
  status: r.status,
  mappingVersion: r.mappingVersion,
  embeddingModelVersion: r.embeddingModelVersion,
  index: r.index,
  previousIndex: r.previousIndex,
  previousRetiresAt: r.previousRetiresAt?.toISOString() ?? null,
  documents: r.documents,
  failureReason: r.failureReason,
  requestedBy: r.requestedBy ?? '00000000-0000-0000-0000-000000000000',
  startedAt: r.startedAt?.toISOString() ?? null,
  finishedAt: r.finishedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

const encode = (r: ReindexRunRecord): string =>
  Buffer.from(JSON.stringify([r.createdAt.toISOString(), r.runId])).toString(
    'base64url',
  );

function decode(cursor: string): { createdAt: Date; runId: string } {
  try {
    const [at, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as [string, string];
    const createdAt = new Date(at);
    if (Number.isNaN(createdAt.getTime()) || !UUID.test(id)) throw new Error();
    return { createdAt, runId: id };
  } catch {
    throw new InvalidCursorError();
  }
}

/** Reads of the run table: one run, or the newest-first keyset list. */
@Injectable()
export class GetRunsService {
  constructor(
    @Inject(REINDEX_RUN_REPOSITORY) private readonly runs: ReindexRunRepository,
  ) {}

  async get(runId: string): Promise<ReindexRun> {
    const run = await this.runs.get(runId);
    if (!run) throw new RunNotFoundError();
    return toRunView(run);
  }

  async list(limit: number, cursor?: string) {
    const rows = await this.runs.list(limit + 1, cursor ? decode(cursor) : null);
    const page = rows.slice(0, limit);
    return {
      items: page.map(toRunView),
      nextCursor:
        rows.length > limit ? encode(page[page.length - 1]) : null,
    };
  }
}
