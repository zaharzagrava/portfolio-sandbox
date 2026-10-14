import { createHmac } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 6;

/**
 * A stable pseudonym of a bidder within one auction (S21 FR-034, research R-12): the first 6 Crockford base32
 * characters of HMAC-SHA256(secret, auctionId:bidderId). Stateless, not reversible, unlinkable across auctions
 * (the auction ID is part of the message). Rotating the secret changes aliases mid-auction.
 */
export function bidderAlias(
  secret: string,
  auctionId: string,
  bidderId: string,
): string {
  if (Buffer.byteLength(secret) < 32)
    throw new Error('auctions_alias_secret must be at least 32 bytes');
  const digest = createHmac('sha256', secret)
    .update(`${auctionId}:${bidderId}`)
    .digest();
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += CROCKFORD[digest[i] & 31];
  return `Bidder ${out}`;
}
