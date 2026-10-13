import { DestinationNotAllowedError } from './link-errors';

export { DestinationNotAllowedError };

export const DESTINATION_MAX = 2048;
// eslint-disable-next-line no-control-regex -- refusing whitespace and control characters is the point
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Destination policy (FR-012 - FR-014, G6): an absolute `https` URL (http only for a localhost storefront in
 * development) whose parsed host, after IDNA normalisation, equals the storefront host or its `www.` form. No
 * user-info, no backslash, no port other than the default, no trailing dot. Pure: the storefront origin is passed in.
 * Returns the normalised URL with every `ref` parameter removed (order, encoding and fragment untouched).
 */
export function checkDestination(
  destination: string,
  storefrontOrigin: string,
): string {
  if (
    destination.length === 0 ||
    destination.length > DESTINATION_MAX ||
    WHITESPACE_OR_CONTROL.test(destination) ||
    destination.includes('\\')
  )
    throw new DestinationNotAllowedError();

  let url: URL;
  let front: URL;
  try {
    url = new URL(destination);
    front = new URL(storefrontOrigin);
  } catch {
    throw new DestinationNotAllowedError();
  }

  const local = LOCAL_HOSTS.has(front.hostname) && front.protocol === 'http:';
  if (url.protocol !== front.protocol || (url.protocol !== 'https:' && !local))
    throw new DestinationNotAllowedError();
  if (url.username || url.password || url.hostname.endsWith('.'))
    throw new DestinationNotAllowedError();
  // `host` carries a non-default port, so a port other than the storefront's never matches.
  if (url.host !== front.host && url.host !== `www.${front.host}`)
    throw new DestinationNotAllowedError();

  const query = withoutRef(url.search.slice(1));
  return `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ''}${url.hash}`;
}

function withoutRef(rawQuery: string): string {
  if (!rawQuery) return '';
  return rawQuery
    .split('&')
    .filter((pair) => {
      const name = pair.split('=', 1)[0];
      let decoded = name;
      try {
        decoded = decodeURIComponent(name.replace(/\+/g, ' '));
      } catch {
        /* keep the raw name */
      }
      return decoded !== 'ref';
    })
    .join('&');
}

/** `ref=<code>` goes after the existing query and before the fragment; everything else stays as stored. */
export function assembleRedirectUrl(stored: string, code: string): string {
  const url = new URL(stored);
  const query = url.search.slice(1);
  return `${url.protocol}//${url.host}${url.pathname}?${query ? `${query}&` : ''}ref=${encodeURIComponent(code)}${url.hash}`;
}
