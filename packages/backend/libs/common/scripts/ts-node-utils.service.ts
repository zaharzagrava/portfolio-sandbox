import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class TsNodeUtilsService {
  private readonly l = new Logger(TsNodeUtilsService.name);

  public randomInRange(min: number, max: number) {
    return Math.floor(Math.random() * (max - min) + min);
  }

  public async delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  public reparse(obj: any) {
    return JSON.parse(JSON.stringify(obj));
  }
}
