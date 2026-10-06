import {
  IntersectionType,
  ApiPropertyOptional,
  PickType,
} from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  IsEmail,
  IsBoolean,
  IsDate,
} from 'class-validator';
import { Role } from '../infra/models/user.model';
import { IdField, TimestampsFields } from '@app/common/types';

// --- --- --- --- --- Internal Types --- --- --- --- --- //
export class CreateUserDto {
  // --- --- --- --- --- Email --- --- --- --- --- //
  @ApiProperty()
  @IsString({ message: 'Email must be a string' })
  @IsEmail({}, { message: 'Email must be a valid email' })
  @IsOptional({ message: 'Email must be a string' })
  @ApiProperty()
  email: string;

  @ApiProperty()
  @IsString({ message: 'New email must be a string' })
  @IsEmail({}, { message: 'New email must be a valid email' })
  @IsOptional({ message: 'New email must be a string' })
  @ApiProperty()
  newEmail: string;

  @ApiProperty()
  @IsString({ message: 'Description must be a string' })
  @IsOptional({ message: 'Description must be a string' })
  @ApiProperty()
  isEmailVerified?: boolean | null;

  @ApiProperty()
  emailVerificationToken?: string | null;

  @ApiProperty()
  @IsDate()
  @IsOptional({ message: 'Email code sent at must be a date' })
  emailCodeSentAt: Date | null;

  // --- --- --- --- --- Password --- --- --- --- --- //
  @ApiProperty()
  @IsString({ message: 'Password must be a string' })
  password: string;

  @ApiProperty()
  passwordResetToken?: string | null;

  @ApiProperty()
  role: Role;
}

export class UserRawDto extends IntersectionType(
  IntersectionType(CreateUserDto, TimestampsFields),
  IdField,
) { }

export class UserFullDto extends UserRawDto {

}


// --- --- --- --- --- POST /login --- --- --- --- --- //
export class LoginUserDto {
  @ApiProperty()
  @IsString({ message: 'Email must be a string' })
  @IsEmail({}, { message: 'Email must be a valid email' })
  @IsOptional({ message: 'Email must be a string' })
  @ApiProperty()
  email: string;
}
