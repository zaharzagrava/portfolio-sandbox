import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

/** Length, trimming and character rules live in the application layer (one place, FR-002); here only shape. */
export class CreatePostDto {
  @ApiProperty() @IsString() title: string;
  @ApiPropertyOptional({ description: 'Markdown' })
  @IsOptional()
  @IsString()
  body?: string;
}

export class CreateCommentDto {
  @ApiProperty({ description: 'Markdown' }) @IsString() body: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
}

/** `{value}` only: the target type is resolved by the server and a client-sent one is refused. */
export class VoteDto {
  @ApiProperty({ enum: [-1, 0, 1] }) @IsIn([-1, 0, 1]) value: -1 | 0 | 1;
}

const POSITIVE_INT = /^[0-9]{1,4}$/;

export class BoardListQueryDto {
  @ApiPropertyOptional({ enum: ['hot', 'top', 'new'] })
  @IsOptional()
  @IsIn(['hot', 'top', 'new'])
  sort?: 'hot' | 'top' | 'new';

  @ApiPropertyOptional({ enum: ['day', 'week', 'month', 'year', 'all'] })
  @IsOptional()
  @IsIn(['day', 'week', 'month', 'year', 'all'])
  window?: 'day' | 'week' | 'month' | 'year' | 'all';

  @ApiPropertyOptional() @IsOptional() @Matches(POSITIVE_INT) limit?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cursor?: string;
}

export class ThreadQueryDto {
  @ApiPropertyOptional({ enum: ['best', 'new', 'old'] })
  @IsOptional()
  @IsIn(['best', 'new', 'old'])
  sort?: 'best' | 'new' | 'old';

  @ApiPropertyOptional() @IsOptional() @Matches(POSITIVE_INT) limit?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cursor?: string;
}

export class RepliesQueryDto {
  @ApiPropertyOptional() @IsOptional() @Matches(POSITIVE_INT) limit?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cursor?: string;
}
