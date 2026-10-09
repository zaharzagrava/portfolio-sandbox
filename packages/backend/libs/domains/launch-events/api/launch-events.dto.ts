import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateLaunchEventDto {
  @ApiProperty() @IsString() @MaxLength(120) title: string;
  @ApiProperty() @IsString() @MaxLength(200) venue: string;
  @ApiProperty() @IsDateString() startsAt: string;
  @ApiProperty() @IsDateString() salesOpenAt: string;
  @ApiProperty() @IsInt() @Min(1) @Max(100_000) seatCount: number;
  @ApiProperty({ default: 20 }) @IsInt() @Min(1) @Max(500) seatsPerRow: number =
    20;
  @ApiProperty({ default: 2 }) @IsInt() @Min(1) @Max(10) perUserLimit: number =
    2;
  @ApiProperty({ default: 200 })
  @IsInt()
  @Min(1)
  @Max(100_000)
  admissionRatePerSec: number = 200;
}

export class HoldSeatsDto {
  @ApiProperty({ type: [Number] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  seats: number[];
}
