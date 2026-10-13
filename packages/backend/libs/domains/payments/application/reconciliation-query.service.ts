import { Inject, Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import type {
  ReconciliationIssue,
  ReconciliationRun,
} from '@marketplace-sandbox/contracts';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  isTimeCursor,
} from '../domain/ledger-cursor';
import {
  RECONCILIATION_STORE,
  type ReconciliationStore,
} from '../domain/ledger-ports';
import { ledgerCursorSecret } from './cursor-secret';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** The finance operator's lists (S14 FR-038): newest first by keyset with a signed cursor and a unique tiebreaker. */
@Injectable()
export class ReconciliationQueryService {
  constructor(
    @Inject(RECONCILIATION_STORE) private readonly store: ReconciliationStore,
    private readonly config: ApiConfigService,
  ) {}

  async runs(input: {
    limit: number;
    cursor?: string;
  }): Promise<Page<ReconciliationRun>> {
    const secret = ledgerCursorSecret(this.config);
    const after = input.cursor
      ? decodeLedgerCursor(input.cursor, secret, isTimeCursor)
      : null;
    const rows = await this.store.listRuns({ limit: input.limit + 1, after });
    return this.page(rows, input.limit, secret);
  }

  async issues(input: {
    status?: string;
    kind?: string;
    day?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<ReconciliationIssue>> {
    const secret = ledgerCursorSecret(this.config);
    const after = input.cursor
      ? decodeLedgerCursor(input.cursor, secret, isTimeCursor)
      : null;
    const rows = await this.store.listIssues({
      status: input.status,
      kind: input.kind,
      day: input.day,
      limit: input.limit + 1,
      after,
    });
    return this.page(rows, input.limit, secret);
  }

  private page<T extends { id: string }>(
    rows: { item: T; t: string }[],
    limit: number,
    secret: string,
  ): Page<T> {
    const shown = rows.slice(0, limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((r) => r.item),
      nextCursor:
        rows.length > limit && last
          ? encodeLedgerCursor({ t: last.t, id: last.item.id }, secret)
          : null,
    };
  }
}
