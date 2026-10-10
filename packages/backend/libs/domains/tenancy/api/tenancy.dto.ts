import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { SLUG_PATTERN } from '../domain/slug-policy';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Request bodies are strict: the global pipe whitelists and refuses unknown fields (`400 validation_failed`). */
export class CreateShopDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @ApiProperty({
    description: 'URL-safe handle, unique across the marketplace, immutable',
  })
  @Matches(SLUG_PATTERN)
  slug: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  region?: string;
}

export class PatchShopDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;
}

/** Cursor pagination parameters, parsed by the controller so a bad value is one `validation_failed`. */
export class PageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  limit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class InviteListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'accepted', 'revoked', 'expired'] })
  @IsOptional()
  @IsIn(['pending', 'accepted', 'revoked', 'expired'])
  status?: 'pending' | 'accepted' | 'revoked' | 'expired';
}

export class InviteMemberDto {
  @ApiProperty()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ enum: ['ADMIN', 'STAFF', 'VIEWER'] })
  @IsIn(['ADMIN', 'STAFF', 'VIEWER'])
  role: 'ADMIN' | 'STAFF' | 'VIEWER';
}

export class AcceptInviteDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  token: string;
}

export class ChangeRoleDto {
  @ApiProperty({ enum: ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'] })
  @IsIn(['OWNER', 'ADMIN', 'STAFF', 'VIEWER'])
  role: 'OWNER' | 'ADMIN' | 'STAFF' | 'VIEWER';
}

export class ShopSsoConfigDto {
  @ApiProperty({ example: 'https://login.microsoftonline.com/<tenant>/v2.0' })
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  issuer: string;

  @ApiProperty()
  @IsString()
  @MaxLength(256)
  clientId: string;

  @ApiProperty()
  @IsString()
  @MaxLength(512)
  clientSecret: string;
}
