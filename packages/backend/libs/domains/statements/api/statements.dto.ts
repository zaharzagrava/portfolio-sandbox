import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class SetCommissionRateDto {
  @ApiPropertyOptional({ description: 'Omit for the marketplace default' }) @IsOptional() @IsUUID() shopId?: string;
  @ApiProperty({ example: 'electronics' }) @IsString() @MaxLength(64) category: string;
  @ApiProperty({ description: 'Basis points, 750 = 7.5%' }) @IsInt() @Min(0) @Max(10_000) rateBps: number;
  @ApiProperty() @IsDateString() validFrom: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() validTo?: string;
  @ApiProperty() @IsString() @MaxLength(200) reason: string;
}
