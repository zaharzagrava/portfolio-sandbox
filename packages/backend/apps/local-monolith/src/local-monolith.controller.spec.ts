import { Test, TestingModule } from '@nestjs/testing';
import { LocalMonolithController } from './local-monolith.controller';
import { LocalMonolithService } from './local-monolith.service';

describe('LocalMonolithController', () => {
  let localMonolithController: LocalMonolithController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [LocalMonolithController],
      providers: [LocalMonolithService],
    }).compile();

    localMonolithController = app.get<LocalMonolithController>(LocalMonolithController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(localMonolithController.getHello()).toBe('Hello World!');
    });
  });
});
