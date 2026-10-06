import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Role } from '../infra/models/user.model';

/** Roles a user may pick for themselves at sign-up. */
export const SELF_ASSIGNABLE_ROLES = [Role.USER, Role.SELLER] as const;

export class RegisterDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(72) // bcrypt ignores everything past 72 bytes
  password: string;

  @ApiPropertyOptional({ enum: SELF_ASSIGNABLE_ROLES, default: Role.USER })
  @IsOptional()
  @IsIn(SELF_ASSIGNABLE_ROLES)
  role?: (typeof SELF_ASSIGNABLE_ROLES)[number];
}

export class PasswordLoginDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @MaxLength(72)
  password: string;
}

export class JwtPayloadDto {
  @ApiProperty()
  sub: string;

  @ApiProperty({ enum: Role })
  role: Role;
}

export class JwtTokenDto {
  @ApiProperty()
  token: string;

  @ApiProperty()
  expiresIn: string | number;
}

export class AuthUserDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string | null;

  @ApiProperty({ enum: Role })
  role: Role;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken: JwtTokenDto;

  @ApiProperty()
  user: AuthUserDto;
}

// --- --- --- --- --- SD-39 sessions / MFA --- --- --- --- --- //
export class MfaVerifyDto {
  @ApiProperty()
  @IsString()
  @MaxLength(4096)
  mfaToken: string;

  @ApiProperty({ description: '6-digit TOTP code or a recovery code' })
  @IsString()
  @MaxLength(32)
  code: string;
}

export class MfaConfirmDto {
  @ApiProperty()
  @IsString()
  @MaxLength(6)
  code: string;
}

export class RefreshDto {
  @ApiPropertyOptional({ description: 'Mobile/server clients send it in the body; browsers use the __Host-refresh cookie' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  refreshToken?: string;
}
