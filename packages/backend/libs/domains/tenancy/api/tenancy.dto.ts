import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateShopDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @ApiProperty({
    description: 'URL-safe handle, unique across the marketplace',
  })
  @Matches(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/)
  slug: string;
}

export class InviteMemberDto {
  @ApiProperty()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email: string;

  @ApiProperty({ enum: ['ADMIN', 'STAFF', 'VIEWER'] })
  @IsIn(['ADMIN', 'STAFF', 'VIEWER'])
  role: 'ADMIN' | 'STAFF' | 'VIEWER';
}

export class AcceptInviteDto {
  @ApiProperty()
  @IsString()
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
