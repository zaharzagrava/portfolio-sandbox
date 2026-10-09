import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreatePostDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) title: string;
  @ApiProperty({ description: 'Markdown' })
  @IsString()
  @MaxLength(40_000)
  body: string;
}

export class CreateCommentDto {
  @ApiProperty({ description: 'Markdown' })
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  body: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
}

export class VoteDto {
  @ApiProperty({ enum: ['post', 'comment'] })
  @IsIn(['post', 'comment'])
  targetType: 'post' | 'comment';
  @ApiProperty({ enum: [-1, 0, 1] }) @IsIn([-1, 0, 1]) value: -1 | 0 | 1;
}
