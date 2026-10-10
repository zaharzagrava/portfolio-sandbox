export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'blog',
  'cdn',
  'dashboard',
  'help',
  'login',
  'logout',
  'mail',
  'null',
  'root',
  'settings',
  'shop',
  'shops',
  'signup',
  'static',
  'status',
  'support',
  'undefined',
  'www',
]);

/** 3-40 characters of `[a-z0-9-]`, not starting or ending with a hyphen (FR-002). */
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
/**
 * Handles the platform generates itself: `seller-<id>` (legacy provisioning), `<slug>-sandbox` (sandbox shops) and
 * `deleted-<id>` (tombstones). A user can never claim one of them.
 */
const RESERVED_PREFIXES = ['seller-', 'deleted-'];
const RESERVED_SUFFIXES = ['-sandbox'];

export type SlugCheck = 'ok' | 'invalid' | 'reserved';

export function checkSlug(slug: string): SlugCheck {
  if (!SLUG.test(slug)) return 'invalid';
  if (
    RESERVED_SLUGS.has(slug) ||
    RESERVED_PREFIXES.some((p) => slug.startsWith(p)) ||
    RESERVED_SUFFIXES.some((s) => slug.endsWith(s))
  )
    return 'reserved';
  return 'ok';
}

export const SLUG_PATTERN = SLUG;
