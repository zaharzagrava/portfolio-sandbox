import { ApiProperty, PickType } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class IdField {
  @IsNotEmpty()
  @IsString()
  @ApiProperty()
  id: string;
}

export enum StringifiedBoolean {
  true = 'true',
  false = 'false',
}

export enum OrderDirection {
  ASC = 'ASC',
  DESC = 'DESC',
}

export enum Environment {
  local = 'local',
  test = 'test',
  development = 'development',
  staging = 'staging',
  preprod = 'preprod',
  production = 'production',
}

export const Environments = Object.values(Environment);


export class TimestampsFields {
  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({ type: 'string', nullable: true })
  deletedAt: Date | null;
}


export class DeletableTimestampsFields extends PickType(TimestampsFields, ['createdAt', 'updatedAt']) {
}

export class ImmutableTimestampsFields extends PickType(TimestampsFields, ['createdAt']) {
}

export interface FileData {
  filename: string;
  file: Uint8Array;
}

export interface RequestArgs {
  url: string;
  params?: any;
  headers?: any;
  data?: any;
}

export enum S3BucketName {
  MAIN = 'payment-system-main',
}
