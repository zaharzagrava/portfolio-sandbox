import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { linkStateOf } from '../domain/link-state';
import { LINK_REPOSITORY, type LinkRepository } from '../domain/ports';
import { isValidCode } from './code-format';

export const MAX_ATTRIBUTION_CODES = 100;

export interface LinkAttribution {
  code: string;
  ownerId: string;
  status: 'ACTIVE' | 'EXPIRED' | 'DISABLED';
}

export class TooManyCodesError extends Error {
  constructor() {
    super(`at most ${MAX_ATTRIBUTION_CODES} codes per lookup`);
    this.name = 'TooManyCodesError';
  }
}

/** The store could not answer; never an empty result that reads as "no such link" (AS-47). */
export class AttributionUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('link attribution unavailable');
    this.name = 'AttributionUnavailableError';
    this.cause = cause;
  }
}

/**
 * Provider side of R1 (S37 FR-068): who owns the links behind the `ref` codes a checkout carries. Batched, no
 * destination and no click data in the answer. An expired link stays resolvable until its record is purged.
 */
@Injectable()
export class LinkAttributionService {
  constructor(
    @Inject(LINK_REPOSITORY) private readonly links: LinkRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async resolveAttributions(
    codes: string[],
  ): Promise<Record<string, LinkAttribution>> {
    if (codes.length > MAX_ATTRIBUTION_CODES) throw new TooManyCodesError();
    const wanted = [...new Set(codes.filter(isValidCode))];
    if (wanted.length === 0) return {};
    let rows;
    try {
      rows = await this.links.batchGet(wanted);
    } catch (error) {
      throw new AttributionUnavailableError(error);
    }
    const now = this.clock.now();
    return Object.fromEntries(
      rows.map((link) => [
        link.code,
        {
          code: link.code,
          ownerId: link.ownerId,
          status: linkStateOf(link, now),
        },
      ]),
    );
  }
}
