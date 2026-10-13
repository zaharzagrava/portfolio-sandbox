import {
  SHORT_LINK_ALIAS_MAX,
  SHORT_LINK_ALIAS_MIN,
  SHORT_LINK_ALIAS_PATTERN,
} from '@marketplace-sandbox/contracts';

/** Words nobody may claim (FR-031); entries shorter than the alias minimum could never pass the format check anyway. */
export const DEFAULT_RESERVED_ALIASES: ReadonlySet<string> = new Set([
  'api',
  'admin',
  'links',
  'login',
  'static',
  'health',
  'status',
  'assets',
  'checkout',
  'cart',
  'help',
  'support',
]);

/** Lower case, 4-32 characters, `a-z0-9` and single dashes, no leading or trailing dash (FR-030). */
export function isValidAlias(alias: string): boolean {
  return (
    alias.length >= SHORT_LINK_ALIAS_MIN &&
    alias.length <= SHORT_LINK_ALIAS_MAX &&
    SHORT_LINK_ALIAS_PATTERN.test(alias)
  );
}

/** The configured comma list merged with the built-in one; blanks and entries shorter than 4 characters are ignored. */
export function parseReservedAliases(configured: string): ReadonlySet<string> {
  const extra = configured
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length >= SHORT_LINK_ALIAS_MIN);
  return new Set([...DEFAULT_RESERVED_ALIASES, ...extra]);
}

export function isReservedAlias(
  alias: string,
  reserved: ReadonlySet<string>,
): boolean {
  return reserved.has(alias);
}
