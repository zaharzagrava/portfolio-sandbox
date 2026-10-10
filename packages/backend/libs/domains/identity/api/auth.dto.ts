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
import {
  EMAIL_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from '../domain/password-policy';

/** Roles a user may pick for themselves at sign-up. */
export const SELF_ASSIGNABLE_ROLES = [Role.USER, Role.SELLER] as const;

const normalizeEmailInput = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @ApiProperty()
  @Transform(normalizeEmailInput)
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email: string;

  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password: string;

  @ApiPropertyOptional({ enum: SELF_ASSIGNABLE_ROLES, default: Role.USER })
  @IsOptional()
  @IsIn(SELF_ASSIGNABLE_ROLES)
  role?: (typeof SELF_ASSIGNABLE_ROLES)[number];
}

export class PasswordLoginDto {
  @ApiProperty()
  @Transform(normalizeEmailInput)
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email: string;

  /** Login never applies the registration policy: older, shorter passwords keep working. Only the cap applies. */
  @ApiProperty({ maxLength: PASSWORD_MAX })
  @IsString()
  @MaxLength(PASSWORD_MAX)
  password: string;
}

export class AuthUserDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string | null;

  @ApiProperty({ enum: Role })
  role: Role;
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
  @ApiPropertyOptional({
    description:
      'Mobile/server clients send it in the body; browsers use the __Host-refresh cookie',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  refreshToken?: string;
}
