import { Module } from '@nestjs/common';
import { FirebaseService } from './firebase.service';
import { ApiConfigModule } from '@app/common/config/api-config.module';

@Module({
  imports: [ApiConfigModule],
  providers: [FirebaseService],
  controllers: [],
  exports: [FirebaseService],
})
export class FirebaseModule {}
