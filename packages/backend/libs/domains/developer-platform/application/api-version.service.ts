import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import type { ApiVersionStateDto, PinVersionResultDto } from './dto';
import { ApiError } from '../domain/errors';
import { SettingsRepository, VersionPinCache } from '../domain/ports';
import {
  apiVersions,
  latestVersion,
  VERSION_REGISTRY,
  versionEntry,
} from '../domain/version-registry';

const MAX_SHOP_IDS = 500;

/**
 * The versions of the public API and each shop's pin (FR-024, FR-025, FR-028). Exported through the barrel (R1) so
 * other capabilities (S43 webhooks) read versions and pins from here instead of keeping lists of their own.
 */
@Injectable()
export class ApiVersionService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly pins: VersionPinCache,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registered versions that are not retired (and, with `at`, whose sunset has not passed). */
  supportedVersions(at?: Date): readonly string[] {
    return apiVersions().filter((v) => {
      const lifecycle = versionEntry(v)!.lifecycle;
      if (lifecycle.status === 'retired') return false;
      return !(
        at &&
        lifecycle.status === 'deprecated' &&
        Date.parse(lifecycle.sunset) <= at.getTime()
      );
    });
  }

  latestVersion(): string {
    return latestVersion();
  }

  isSupported(version: string): boolean {
    return this.supportedVersions().includes(version);
  }

  /** At most 500 shops, one statement; a shop without a pin is on the latest version. */
  async getPinnedVersions(shopIds: string[]): Promise<Map<string, string>> {
    if (shopIds.length > MAX_SHOP_IDS)
      throw new ApiError('validation_failed', `At most ${MAX_SHOP_IDS} shops.`);
    const pinned = await this.settings.getPinnedMany(shopIds);
    return new Map(
      shopIds.map((id) => [id, pinned.get(id) ?? latestVersion()]),
    );
  }

  /**
   * The version a call of this shop is served at when it names none: the pin, which a shop that has none gets at its
   * first authenticated call (once). Cached for 5 s so a change is seen by every instance within that bound (FR-028).
   */
  async pinnedVersionOf(shopId: string): Promise<string> {
    const cached = await this.pins.get(shopId).catch(() => null);
    if (cached) return cached;
    const stored = await this.settings.getPinned(shopId);
    const version =
      stored?.version ??
      (await this.settings.pinIfAbsent(
        shopId,
        latestVersion(),
        this.clock.now(),
      ));
    await this.pins.put(shopId, version, 5).catch(() => undefined);
    return version;
  }

  async state(shopId: string): Promise<ApiVersionStateDto> {
    const pin = await this.settings.getPinned(shopId);
    return {
      version: pin?.version ?? latestVersion(),
      pinnedAt: pin?.pinnedAt?.toISOString() ?? null,
      supported: VERSION_REGISTRY.map((v) => ({
        version: v.version,
        status: v.lifecycle.status,
        ...(v.lifecycle.status === 'deprecated'
          ? { sunset: v.lifecycle.sunset }
          : {}),
      })),
      latest: latestVersion(),
    };
  }

  /** Any registered, non-retired version (FR-028). */
  async pin(
    shopId: string,
    version: string,
    actorId: string,
  ): Promise<PinVersionResultDto> {
    const entry = versionEntry(version);
    if (!entry)
      throw new ApiError('invalid_version', 'Unknown API version.', {
        errors: [{ field: 'version', code: 'unsupported' }],
      });
    if (entry.lifecycle.status === 'retired')
      throw new ApiError('version_retired', 'This version is retired.', {
        status: 422,
        extensions: { supported: [...this.supportedVersions()] },
      });
    const changed = await this.settings.change({
      shopId,
      version,
      now: this.clock.now(),
      actorId,
    });
    await this.pins.invalidate(shopId);
    return {
      version,
      previousVersion: changed.previousVersion,
      pinnedAt: changed.pinnedAt.toISOString(),
    };
  }
}
