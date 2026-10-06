/** Same-site paths only: an absolute or protocol-relative `returnUrl` would be an open redirect. */
export function safeReturnUrl(requested: string | null | undefined): string {
  if (!requested || !requested.startsWith('/') || requested.startsWith('//') || requested.startsWith('/\\')) return '/';
  return requested;
}
