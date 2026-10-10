import { Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '@app/infrastructure/context';

export type ProductAuditAction =
  | 'product.created'
  | 'product.updated'
  | 'product.archived'
  | 'product.restored';

/**
 * One structured line per product mutation (VIII.1, AS-85): `{action, requestId, shopId, productId, actorId, version}`.
 * Identifiers only: never a title, a description or any other body field.
 */
@Injectable()
export class ProductAudit {
  private readonly logger = new Logger('Audit');

  constructor(private readonly context: RequestContext) {}

  record(
    action: ProductAuditAction,
    fields: {
      shopId: string;
      productId: string;
      actorId: string | null;
      version: number;
    },
  ): void {
    this.logger.log({
      action,
      requestId: this.context.requestId,
      ...fields,
    });
  }
}
