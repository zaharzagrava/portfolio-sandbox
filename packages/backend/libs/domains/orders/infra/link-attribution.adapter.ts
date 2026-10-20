import { Injectable } from '@nestjs/common';
import { LinkAttributionService } from '@app/domains/marketing';
import type {
  AttributionResolverPort,
  ResolvedAttribution,
} from '../domain/ports';

/** The owner and state of the share link behind a checkout `ref`, through marketing's R1 lookup (J05). */
@Injectable()
export class LinkAttributionAdapter implements AttributionResolverPort {
  constructor(private readonly links: LinkAttributionService) {}

  async resolve(code: string): Promise<ResolvedAttribution | null> {
    const found = await this.links.resolveAttributions([code]);
    const link = found[code];
    return link
      ? { code: link.code, ownerId: link.ownerId, status: link.status }
      : null;
  }
}
