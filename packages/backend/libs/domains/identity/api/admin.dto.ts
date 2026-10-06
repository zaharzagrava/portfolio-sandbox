import { ApiProperty } from '@nestjs/swagger';

export class DbCredsDto {
  @ApiProperty()
  port: number;

  @ApiProperty()
  password: string;

  @ApiProperty()
  username: string;

  @ApiProperty()
  database: string;

  @ApiProperty()
  host: string;

  @ApiProperty()
  isSsh?: boolean;
}

export class GetReportsDto {
  @ApiProperty()
  period: number;
}
