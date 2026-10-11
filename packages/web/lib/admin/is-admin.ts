// Stand-in for the W06 contract: the owner replaces the body, never the name or props.

/** Presentation only (the Admin menu entry); authorization is enforced by the API and W06's pages. */
export function isAdmin(user: { role?: string } | null | undefined): boolean {
  return user?.role === 'ADMIN';
}
