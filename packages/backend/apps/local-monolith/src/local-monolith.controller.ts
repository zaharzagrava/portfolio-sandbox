import { Controller, Get } from '@nestjs/common';
import { LocalMonolithService } from './local-monolith.service';

@Controller()
export class LocalMonolithController {
  constructor(private readonly localMonolithService: LocalMonolithService) {}

  @Get()
  getHello(): string {
    return this.localMonolithService.getHello();
  }
}
