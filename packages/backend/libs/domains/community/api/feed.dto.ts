import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { FEED_ACCOUNT_ID_PATTERN } from '@marketplace-sandbox/contracts';
import { feedValidationFailed } from '../domain/feed-errors';

/** `shop:<uuid>` or `user:<uuid>`, lowercase uuid. */
export class AccountParamDto {
  @ApiProperty({ example: 'shop:6f1c0f0e-8f4b-4d62-9d0a-0d2f3a4b5c6d' })
  @Matches(FEED_ACCOUNT_ID_PATTERN)
  accountId: string;
}

const POSITIVE_INT = /^[0-9]{1,4}$/;

/** Keyset page parameters; the numeric range is enforced by `pageLimit`, the cursor by the cursor codec. */
export class PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @Matches(POSITIVE_INT) limit?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cursor?: string;
}

export class FollowStatusQueryDto {
  @ApiProperty({ description: 'Comma-separated account ids, at most 100' })
  @IsString()
  @IsNotEmpty()
  accountIds: string;
}

/** `limit` is an integer from 1 to `max`; anything else is refused, never clamped. */
export function pageLimit(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > max)
    throw feedValidationFailed(['limit']);
  return limit;
}

export const splitAccountIds = (raw: string): string[] => raw.split(',');
