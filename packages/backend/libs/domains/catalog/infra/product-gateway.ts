import { Injectable } from '@nestjs/common';
import type { ProductMemberView } from '@marketplace-sandbox/contracts';
import { ProductCommandService } from '../application/product-command.service';
import type {
  ProductFields,
  ProductGateway,
  ProductSnapshotView,
} from '../domain/draft-ports';
import { VersionConflictError } from '../domain/product-errors';

const toSnapshot = (view: ProductMemberView): ProductSnapshotView => ({
  id: view.id,
  version: view.version,
  status: view.status,
  title: view.title,
  description: view.description,
  brand: view.brand,
  category: view.category,
  priceMinor: view.priceMinor,
  quantity: view.quantity,
});

/**
 * The draft side of the product command service (R1, same domain): publish writes the product only through
 * `ProductCommandService`, which joins the ambient transaction. An unchanged update is recognised by the version staying
 * where it was (S05 bumps `version` on every real write and never on an unchanged one).
 */
@Injectable()
export class CommandProductGateway implements ProductGateway {
  constructor(private readonly commands: ProductCommandService) {}

  async get(shopId: string, productId: string): Promise<ProductSnapshotView> {
    return toSnapshot(await this.commands.getForShop(shopId, productId));
  }

  async create(
    shopId: string,
    actorId: string,
    fields: ProductFields,
  ): Promise<ProductSnapshotView> {
    return toSnapshot(await this.commands.create(shopId, actorId, fields));
  }

  async update(
    shopId: string,
    productId: string,
    actorId: string,
    expectedVersion: number,
    changes: Partial<ProductFields>,
  ) {
    if (Object.keys(changes).length === 0) {
      // Nothing differs: S05 refuses an update without a field, and an unchanged product keeps its version anyway.
      const current = await this.commands.getForShop(shopId, productId);
      if (current.version !== expectedVersion)
        throw new VersionConflictError(current.version);
      return { product: toSnapshot(current), unchanged: true };
    }
    const view = await this.commands.update(
      shopId,
      productId,
      { expectedVersion, ...changes },
      actorId,
    );
    return {
      product: toSnapshot(view),
      unchanged: view.version === expectedVersion,
    };
  }
}
