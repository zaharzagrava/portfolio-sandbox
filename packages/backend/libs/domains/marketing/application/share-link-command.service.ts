import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CreateShortLinkRequest,
  ShortLink,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  isReservedAlias,
  isValidAlias,
  parseReservedAliases,
} from '../domain/alias-rules';
import { scramble, toBase62 } from '../domain/codes';
import { checkDestination } from '../domain/destination-policy';
import {
  aliasReserved,
  aliasTaken,
  codeGenerationFailed,
  CodeRangeError,
  destinationBlocked,
  destinationCheckUnavailable,
  linkLimitReached,
  linkNotActive,
  linkNotFound,
  serviceUnavailable,
  validationFailed,
} from '../domain/link-errors';
import {
  linkCodeCollisionCounter,
  linkCreatedCounter,
} from '../domain/link-metrics';
import { canTransition, linkStateOf } from '../domain/link-state';
import {
  CODE_SEQUENCE,
  DESTINATION_REPUTATION,
  DependencyUnavailableError,
  EXISTENCE_FILTER,
  LINK_CACHE,
  LINK_REPOSITORY,
  type CodeSequence,
  type DestinationReputation,
  type ExistenceFilter,
  type LinkCache,
  type LinkRepository,
  type StoredLink,
} from '../domain/ports';
import { isValidCode } from './code-format';
import { publicBase, raceTimeout, toShortLink } from './link-view';

const MAX_GENERATED_ATTEMPTS = 5;
const REPUTATION_TIMEOUT_MS = 2_000;

/**
 * Create, change and disable (S37 US1, US2, US5). Order on create (research R-2): alias format and reserved words
 * before any number is consumed -> destination policy -> reputation (2 s, fail closed) -> code -> filter entry first ->
 * one conditional write that also reserves a place in the owner's counter. Every store failure is a `503`.
 */
@Injectable()
export class ShareLinkCommandService {
  private readonly logger = new Logger(ShareLinkCommandService.name);

  constructor(
    @Inject(LINK_REPOSITORY) private readonly links: LinkRepository,
    @Inject(CODE_SEQUENCE) private readonly sequence: CodeSequence,
    @Inject(EXISTENCE_FILTER) private readonly filter: ExistenceFilter,
    @Inject(LINK_CACHE) private readonly cache: LinkCache,
    @Inject(DESTINATION_REPUTATION)
    private readonly reputation: DestinationReputation,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  async create(
    ownerId: string,
    request: CreateShortLinkRequest,
  ): Promise<ShortLink> {
    const { alias } = request;
    if (alias !== undefined) {
      if (!isValidAlias(alias)) throw validationFailed(['alias']);
      if (
        isReservedAlias(
          alias,
          parseReservedAliases(this.config.get('share_link_reserved_aliases')),
        )
      )
        throw aliasReserved();
    }
    const destination = checkDestination(
      request.destination,
      this.config.get('front_host'),
    );
    await this.screen(destination, ownerId);

    const now = this.clock.now();
    const base: Omit<StoredLink, 'code' | 'kind'> = {
      ownerId,
      destination,
      status: 'ACTIVE',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: request.ttlDays
        ? new Date(now.getTime() + request.ttlDays * 86_400_000).toISOString()
        : null,
    };

    try {
      const link =
        alias !== undefined
          ? await this.createCustom({ ...base, code: alias, kind: 'custom' })
          : await this.createGenerated(base);
      linkCreatedCounter.add(1, { kind: link.kind });
      return toShortLink(link, publicBase(this.config));
    } catch (error) {
      throw this.asApiError(error);
    }
  }

  private async createCustom(link: StoredLink): Promise<StoredLink> {
    await this.filter.add(link.code);
    const outcome = await this.links.create(
      link,
      this.config.get('share_link_max_per_owner'),
      link.createdAt,
    );
    if (outcome === 'code_taken') throw aliasTaken();
    if (outcome === 'limit_reached') throw linkLimitReached();
    // a miss remembered for this alias must not hide the claim (AS-23)
    await this.cache.invalidate(link.code).catch(() => undefined);
    return link;
  }

  private async createGenerated(
    base: Omit<StoredLink, 'code' | 'kind'>,
  ): Promise<StoredLink> {
    for (let attempt = 0; attempt < MAX_GENERATED_ATTEMPTS; attempt++) {
      const code = toBase62(
        scramble(
          await this.sequence.next(),
          this.config.get('share_link_code_key'),
        ),
      );
      const link: StoredLink = { ...base, code, kind: 'generated' };
      // the filter entry comes first: a crash between the two writes may leave a stray entry, never a hidden link
      await this.filter.add(code);
      const outcome = await this.links.create(
        link,
        this.config.get('share_link_max_per_owner'),
        link.createdAt,
      );
      if (outcome === 'created') return link;
      if (outcome === 'limit_reached') throw linkLimitReached();
      linkCodeCollisionCounter.add(1);
    }
    throw codeGenerationFailed();
  }

  async changeDestination(
    ownerId: string,
    code: string,
    destination: string,
  ): Promise<ShortLink> {
    try {
      const current = await this.owned(ownerId, code);
      const now = this.clock.now();
      if (!canTransition(linkStateOf(current, now), 'change'))
        throw linkNotActive();
      const checked = checkDestination(
        destination,
        this.config.get('front_host'),
      );
      await this.screen(checked, ownerId);
      const outcome = await this.links.updateDestination(
        ownerId,
        code,
        checked,
        now.toISOString(),
      );
      if (outcome.kind === 'not_found') throw linkNotFound();
      if (outcome.kind === 'not_active') throw linkNotActive();
      await this.cache.invalidate(code).catch(() => undefined);
      return toShortLink(outcome.link, publicBase(this.config));
    } catch (error) {
      throw this.asApiError(error);
    }
  }

  async disable(ownerId: string, code: string): Promise<ShortLink> {
    try {
      const current = await this.owned(ownerId, code);
      const now = this.clock.now();
      if (!canTransition(linkStateOf(current, now), 'disable'))
        throw linkNotActive();
      const outcome = await this.links.disable(
        ownerId,
        code,
        now.toISOString(),
      );
      if (outcome.kind === 'not_found') throw linkNotFound();
      if (outcome.kind === 'not_active') throw linkNotActive();
      await this.cache.invalidate(code).catch(() => undefined);
      return toShortLink(outcome.link, publicBase(this.config));
    } catch (error) {
      throw this.asApiError(error);
    }
  }

  /** Not yours and not there look the same (FR-083). */
  private async owned(ownerId: string, code: string): Promise<StoredLink> {
    if (!isValidCode(code)) throw linkNotFound();
    const link = await this.links.getOwned(ownerId, code);
    if (!link) throw linkNotFound();
    return link;
  }

  private async screen(destination: string, ownerId: string): Promise<void> {
    let verdict: 'allow' | 'block';
    try {
      verdict = await raceTimeout(
        REPUTATION_TIMEOUT_MS,
        this.reputation.check(destination, ownerId),
        () => new DependencyUnavailableError('destination-reputation'),
      );
    } catch {
      throw destinationCheckUnavailable();
    }
    if (verdict === 'block') throw destinationBlocked();
  }

  /** Domain errors pass; anything a store or counter threw becomes a generic `503` (no store text, no stack). */
  private asApiError(error: unknown): unknown {
    if (error instanceof DependencyUnavailableError) {
      this.logger.warn(`dependency unavailable: ${error.dependency}`);
      return Object.assign(serviceUnavailable(), { cause: error });
    }
    if (error instanceof CodeRangeError) return codeGenerationFailed();
    return error;
  }
}
