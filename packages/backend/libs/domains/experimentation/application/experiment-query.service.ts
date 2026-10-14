import { Inject, Injectable } from '@nestjs/common';
import type {
  Experiment,
  ExperimentHistoryPage,
  ExperimentPage,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { decodeCursor, encodeCursor } from '../domain/experiment-cursor';
import { experimentNotFound } from '../domain/experiment-errors';
import type { ExperimentStatus } from '../domain/experiment-types';
import {
  EXPERIMENT_REPOSITORY,
  type ExperimentRepository,
} from '../domain/ports';
import { toExperimentView } from './experiment-view';

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

/** The admin's reads: list, one experiment and its history (S39 FR-027), all keyset-paged with signed cursors. */
@Injectable()
export class ExperimentQueryService {
  constructor(
    @Inject(EXPERIMENT_REPOSITORY)
    private readonly experiments: ExperimentRepository,
    private readonly config: ApiConfigService,
  ) {}

  async list(query: {
    limit: number;
    cursor?: string;
    status?: ExperimentStatus;
  }): Promise<ExperimentPage> {
    const secret = this.config.get('jwt_secret');
    const after = query.cursor
      ? (() => {
          const fields = decodeCursor(secret, 'experiments', query.cursor, [
            'createdAt',
            'key',
          ]);
          return { createdAt: fields.createdAt, key: fields.key };
        })()
      : undefined;
    const rows = await this.experiments.list({
      limit: query.limit + 1,
      after,
      status: query.status,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toExperimentView),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(secret, 'experiments', {
              createdAt: last.createdAtKey,
              key: last.key,
            })
          : null,
    };
  }

  async get(key: string): Promise<Experiment> {
    const experiment = await this.experiments.find(key);
    if (!experiment) throw experimentNotFound();
    return toExperimentView(experiment);
  }

  async history(
    key: string,
    query: { limit: number; cursor?: string },
  ): Promise<ExperimentHistoryPage> {
    const secret = this.config.get('jwt_secret');
    const scope = `history:${key}`;
    const after = query.cursor
      ? (() => {
          const fields = decodeCursor(secret, scope, query.cursor, [
            'at',
            'id',
          ]);
          return { at: fields.at, id: fields.id };
        })()
      : undefined;
    if (!(await this.experiments.find(key))) throw experimentNotFound();
    const rows = await this.experiments.history(key, query.limit + 1, after);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(secret, scope, { at: last.at, id: last.id })
          : null,
    };
  }
}
