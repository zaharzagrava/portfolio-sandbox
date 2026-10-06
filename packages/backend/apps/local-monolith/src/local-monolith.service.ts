import { Injectable } from '@nestjs/common';

@Injectable()
export class LocalMonolithService {
  getHello(): string {
    return 'Hello World!';
  }
}
