import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
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

export class MoveDirectoryDto {
  @ApiProperty({ example: 'dedicated-1' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  cell: string;

  @ApiProperty({ example: 'eu-central-1' })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  region: string;

  @ApiProperty({ description: 'The directory version the caller read' })
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}

/** The slug of the shop, typed again by the owner as the confirmation. */
export class OffboardShopDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  confirmSlug: string;
}

/** The platform administrator's reason for a status change (suspend, reinstate). */
export class StatusReasonDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}

/** The issuer's scheme and address are judged by the discovery check (`422 sso_issuer_invalid`), not by the pipe. */
export class ShopSsoConfigDto {
  @ApiProperty({ example: 'https://login.microsoftonline.com/<tenant>/v2.0' })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  issuer: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  clientId: string;

  @ApiPropertyOptional({
    description: 'Required the first time; omitted keeps the stored secret',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  clientSecret?: string;

  @ApiPropertyOptional({ enum: ['STAFF', 'VIEWER'] })
  @IsOptional()
  @IsIn(['STAFF', 'VIEWER'])
  defaultRole?: 'STAFF' | 'VIEWER';
}
