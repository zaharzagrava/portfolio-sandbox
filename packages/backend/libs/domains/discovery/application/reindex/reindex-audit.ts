import { Injectable, Logger } from '@nestjs/common';

/**
 * Audit line of an administrator's mutating call (S32 FR-041, AS-52): who, what, which run or version. Never a secret,
 * a token or a query text.
 */
@Injectable()
export class SearchAudit {
  private readonly logger = new Logger('SearchAudit');

  record(fields: {
    actorId: string;
    action: string;
    runId?: string;
    version?: number;
  }): void {
    this.logger.log({ event: 'search.admin', ...fields });
  }
}
