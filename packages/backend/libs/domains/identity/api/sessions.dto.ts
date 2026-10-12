import { ApiProperty } from '@nestjs/swagger';

/** One active session of the signed-in user (`sessionListItemSchema`); no storage key, user ID or family ID. */
export class SessionListItemDto {
  @ApiProperty() sessionId!: string;
  @ApiProperty({ type: String, nullable: true }) device!: string | null;
  @ApiProperty({ type: String, nullable: true }) ip!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) lastUsedAt!: string | null;
  @ApiProperty() current!: boolean;
}
