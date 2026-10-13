import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { cleanCountry, refererOrigin } from '../domain/click-meta';
import {
  assembleRedirectUrl,
  checkDestination,
  DestinationNotAllowedError,
} from '../domain/destination-policy';
import { LinkClicked } from '../domain/link-events';
import {
  linkDestinationRejectedCounter,
  linkFilterBypassedCounter,
  linkRedirectCounter,
  linkResolveCounter,
} from '../domain/link-metrics';
import { linkStateOf } from '../domain/link-state';
import {
  CLICK_PUBLISHER,
  EXISTENCE_FILTER,
  LINK_CACHE,
  LINK_REPOSITORY,
  type ClickEnvelope,
  type ClickPublisher,
  type ExistenceFilter,
  type LinkCache,
  type LinkRepository,
  type StoredLink,
} from '../domain/ports';
import { isValidCode } from './code-format';

export type RedirectResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'not_found' }
  | { kind: 'gone' }
  | { kind: 'unavailable' };

export interface RedirectRequest {
  code: string;
  /** `GET` records a click; `HEAD` resolves the same way and records nothing. */
  record: boolean;
  country?: string;
  referer?: string;
  /** `x-edge-click-recorded` and `x-edge-credential`: the flag counts only with the shared credential. */
  edgeRecorded?: string;
  edgeCredential?: string;
}

/**
 * The redirect (S37 US3): one call, one result. Order: format -> existence filter (bypassed unless trusted) ->
 * cache-aside -> store (500 ms) -> state and destination re-check -> click published off the request path.
 */
@Injectable()
export class RedirectService {
  constructor(
    @Inject(LINK_REPOSITORY) private readonly links: LinkRepository,
    @Inject(EXISTENCE_FILTER) private readonly filter: ExistenceFilter,
    @Inject(LINK_CACHE) private readonly cache: LinkCache,
    @Inject(CLICK_PUBLISHER) private readonly publisher: ClickPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  async resolveRedirect(request: RedirectRequest): Promise<RedirectResult> {
    const result = await this.resolve(request);
    linkRedirectCounter.add(1, {
      outcome: result.kind === 'redirect' ? 'redirected' : result.kind,
    });
    return result;
  }

  private async resolve(request: RedirectRequest): Promise<RedirectResult> {
    const { code } = request;
    if (!isValidCode(code)) return { kind: 'not_found' };

    const answer = await this.filter.check(code);
    if (answer === 'absent') {
      linkResolveCounter.add(1, { source: 'filter_reject' });
      return { kind: 'not_found' };
    }
    if (answer === 'bypassed') linkFilterBypassedCounter.add(1);

    let loaded = false;
    let link: StoredLink | null;
    try {
      link = await this.cache.getOrLoad(code, () => {
        loaded = true;
        return this.links.get(code);
      });
    } catch {
      return { kind: 'unavailable' };
    }
    linkResolveCounter.add(1, { source: loaded ? 'store' : 'cache' });
    if (!link) return { kind: 'not_found' };

    const now = this.clock.now();
    if (linkStateOf(link, now) !== 'ACTIVE') return { kind: 'gone' };

    let destination: string;
    try {
      destination = checkDestination(
        link.destination,
        this.config.get('front_host'),
      );
    } catch (error) {
      if (!(error instanceof DestinationNotAllowedError)) throw error;
      linkDestinationRejectedCounter.add(1);
      return { kind: 'gone' };
    }

    if (request.record && !this.countedAtEdge(request))
      this.recordClick(request, now);
    return {
      kind: 'redirect',
      location: assembleRedirectUrl(destination, code),
    };
  }

  /** The "already counted" flag is believed only with the shared credential (constant-time compare). */
  private countedAtEdge(request: RedirectRequest): boolean {
    if (request.edgeRecorded !== '1' || !request.edgeCredential) return false;
    const expected = Buffer.from(this.config.get('share_link_edge_secret'));
    const given = Buffer.from(request.edgeCredential);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private recordClick(request: RedirectRequest, now: Date): void {
    try {
      const clickId = uuidv7();
      const envelope = LinkClicked.create(
        request.code,
        1,
        {
          clickId,
          code: request.code,
          ts: now.toISOString(),
          country: cleanCountry(request.country),
          referer: refererOrigin(request.referer),
          viaEdge: false,
        },
        now,
      );
      // the click id is the event id: a redelivery is recognisable as the same click
      this.publisher.publish({
        ...envelope,
        eventId: clickId,
      } as ClickEnvelope);
    } catch {
      // a click that cannot be built never costs the visitor their redirect
    }
  }
}
