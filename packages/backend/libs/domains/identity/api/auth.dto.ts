import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { parseReturnPath } from '../domain/return-path';
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
  @ApiPropertyOptional({
    description:
      'The challenge from the password step; with delivery "cookie" it may come from the __Host-mfa-challenge cookie instead',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  mfaToken?: string;

  @ApiProperty({ description: '6-digit TOTP code or a recovery code' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @Matches(/^[0-9A-Za-z-]+$/)
  code: string;

  @ApiPropertyOptional({ enum: ['body', 'cookie'] })
  @IsOptional()
  @IsIn(['body', 'cookie'])
  delivery?: 'body' | 'cookie';
}

/** Confirm, regenerate and disable take an authenticator code, never a recovery code: exactly six digits. */
export class MfaCodeDto {
  @ApiProperty({ description: '6-digit TOTP code' })
  @IsString()
  @Matches(/^[0-9]{6}$/)
  code: string;
}

export class MfaConfirmDto extends MfaCodeDto {}

/** `returnTo` must be a relative path (FR-045); an invalid one is a 400, never rewritten. */
function IsReturnPath(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isReturnPath',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => parseReturnPath(value) !== null,
        defaultMessage: () => 'returnTo must be a relative path',
      },
    });
}

export class OidcStartDto {
  @ApiPropertyOptional({
    description: 'Relative path to land on after sign-in',
  })
  @IsOptional()
  @IsReturnPath()
  returnTo?: string;
}

export class OidcLinkStartDto extends OidcStartDto {
  @ApiPropertyOptional({
    description: '6-digit TOTP code, required when a second factor is enabled',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{6}$/)
  code?: string;
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
