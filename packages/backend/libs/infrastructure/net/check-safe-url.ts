import { parseSafeUrl, SafeUrlOptions } from './safe-url';
import { HostResolver, resolvePublicAddress } from './ssrf-guard';

/**
 * Validates a user-supplied URL without requesting it (endpoint registration, crawler intake): same scheme, port,
 * credential and address rules as `safeGet`/`safeRequest`. Throws a `SafeRequestError`.
 */
export async function checkSafeUrl(
  raw: string,
  options: SafeUrlOptions & { resolver?: HostResolver } = {},
): Promise<void> {
  const url = parseSafeUrl(raw, options);
  await resolvePublicAddress(url.hostname, {
    resolver: options.resolver,
    allowPrivateHosts: options.allowPrivateHosts,
  });
}
