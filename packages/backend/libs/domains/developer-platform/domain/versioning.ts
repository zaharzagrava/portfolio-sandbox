import { ApiError } from './errors';
import {
  apiVersions,
  API_VERSIONS,
  DEPRECATED_ROUTES,
  LATEST_VERSION,
  latestVersion,
  UpgradeContext,
  VERSION_REGISTRY,
  VersionEntry,
  VersionResource,
} from './version-registry';

export { API_VERSIONS, DEPRECATED_ROUTES, LATEST_VERSION, VERSION_REGISTRY };
export type ApiVersion = string;
export type ApiResourceType = VersionResource | 'list';

type Json = Record<string, unknown>;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isApiVersion(value: string | undefined): value is ApiVersion {
  return !!value && apiVersions().includes(value);
}

/**
 * Header → shop pin → latest (FR-025). A header that is not a registered date answers `400 invalid_version` listing
 * the supported versions; a retired one is refused later by the deprecation gate (`410 version_retired`).
 */
export function resolveVersion(input: {
  header: string | undefined;
  pin: string | undefined;
}): ApiVersion {
  if (input.header !== undefined) {
    if (!ISO_DATE.test(input.header) || !isApiVersion(input.header))
      throw new ApiError(
        'invalid_version',
        'Unsupported Marketplace-Version.',
        {
          errors: [{ field: 'Marketplace-Version', code: 'unsupported' }],
          extensions: { supported: [...apiVersions()] },
        },
      );
    return input.header;
  }
  return input.pin && isApiVersion(input.pin) ? input.pin : latestVersion();
}

/** Walks the changes newer than `target`, newest first, undoing each (FR-026). */
export function downgradeResource(
  type: VersionResource,
  resource: Json,
  target: ApiVersion,
): Json {
  let out = resource;
  for (const entry of [...VERSION_REGISTRY].reverse()) {
    if (entry.version <= target) break;
    out = entry.change ? entry.change.downgrade[type](out) : out;
  }
  return out;
}

/** Response of a resource or of a list (each item of `data` is transformed). */
export function downgradeResponse(
  type: ApiResourceType,
  body: unknown,
  target: ApiVersion,
  itemType?: VersionResource,
): unknown {
  if (target === latestVersion() || body === null || typeof body !== 'object')
    return body;
  if (type === 'list') {
    const list = body as { data: Json[] };
    return {
      ...list,
      data: list.data.map((item) => downgradeResource(itemType!, item, target)),
    };
  }
  return downgradeResource(type, body as Json, target);
}

/** Webhook payload code (S43) still calls this name. */
export const transformForVersion = (
  type: ApiResourceType,
  body: unknown,
  target: ApiVersion,
  itemType?: VersionResource,
): unknown => downgradeResponse(type, body, target, itemType);

/** Product create/update body of an older version → the latest shape the handlers accept (FR-026). */
export function upgradeProductWrite(
  body: Json,
  from: ApiVersion,
  ctx: UpgradeContext,
): Json {
  let out = body;
  for (const entry of VERSION_REGISTRY) {
    if (entry.version <= from) continue;
    if (entry.change) out = entry.change.upgradeProductWrite(out, ctx);
  }
  return out;
}

/** Every field name of a resource at `version` (what `fields=` may name), found by downgrading an all-fields sample. */
export function fieldNamesAt(
  type: VersionResource,
  version: ApiVersion,
  latestSample: Json,
): string[] {
  return Object.keys(downgradeResource(type, latestSample, version));
}

/** Startup validation (FR-024, FR-031 of the registry): order, latest not retired, downgrade completeness. */
export function assertVersionRegistryValid(
  registry: readonly VersionEntry[],
): void {
  registry.forEach((e, i) => {
    if (!ISO_DATE.test(e.version))
      throw new Error(`Version "${e.version}" is not an ISO date`);
    if (i > 0 && registry[i - 1].version >= e.version)
      throw new Error(
        `Versions must be in strictly ascending order (${e.version} after ${registry[i - 1].version})`,
      );
    if (i > 0) {
      for (const type of ['product', 'order'] as const)
        if (typeof e.change?.downgrade[type] !== 'function')
          throw new Error(`Version ${e.version} lacks a downgrade for ${type}`);
      if (typeof e.change?.upgradeProductWrite !== 'function')
        throw new Error(`Version ${e.version} lacks a request upgrader`);
    }
  });
  const latest = registry[registry.length - 1];
  if (latest.lifecycle.status === 'retired')
    throw new Error('The latest version can never be retired');
}
