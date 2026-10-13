import type { ShortLink } from '@marketplace-sandbox/contracts';
import type { ApiConfigService } from '@app/common/config';
import type { StoredLink } from '../domain/ports';

/** `share_link_base_url` without a trailing slash. */
export function publicBase(config: ApiConfigService): string {
  return config.get('share_link_base_url').replace(/\/+$/, '');
}

/** The only shape that leaves the API: no owner and no store key (FR-011). */
export function toShortLink(link: StoredLink, base: string): ShortLink {
  return {
    code: link.code,
    shortUrl: `${base}/${link.code}`,
    destination: link.destination,
    status: link.status,
    kind: link.kind,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    expiresAt: link.expiresAt,
    ...(link.disabledAt && { disabledAt: link.disabledAt }),
  };
}

/** A promise that gives up after `ms` (the underlying work is abandoned, not cancelled). */
export async function raceTimeout<T>(
  ms: number,
  work: Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
