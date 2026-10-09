import { Global, Module } from '@nestjs/common';
import { TEST_CLEANUP } from '@app/common/testing/test-cleanup.port';
import { TestCleanupRegistry } from './test-cleanup.registry';

@Global()
@Module({
  providers: [
    TestCleanupRegistry,
    { provide: TEST_CLEANUP, useExisting: TestCleanupRegistry },
  ],
  exports: [TestCleanupRegistry, TEST_CLEANUP],
})
export class TestCleanupModule {}
