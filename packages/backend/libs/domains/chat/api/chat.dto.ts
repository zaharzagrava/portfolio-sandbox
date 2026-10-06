import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ChatChannelMemberRole } from '../infra/models/chat-channel-member.model';

export class CreateChatChannelDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;
}

export class UpdateChatChannelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;
}

export class ListChatMessagesQueryDto {
  @ApiPropertyOptional({
    description: 'Cursor - return messages strictly older than this message id',
  })
  @IsOptional()
  @IsUUID()
  before?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ChatMemberActionDto {
  @ApiProperty()
  @IsUUID()
  userId: string;
}

export class MuteChatMemberDto extends ChatMemberActionDto {
  @ApiProperty({ description: 'Mute duration in minutes' })
  @IsInt()
  @Min(1)
  @Max(60 * 24 * 30)
  minutes: number;
}

export class ChatWsTicketRespDto {
  @ApiProperty()
  ticket: string;

  @ApiProperty()
  wsUrl: string;

  @ApiProperty()
  expiresAt: string;
}

export interface ChatChannelRawDto {
  id: string;
  productId: string;
  sellerId: string;
  title: string;
  isArchived: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  myRole?: ChatChannelMemberRole;
}
