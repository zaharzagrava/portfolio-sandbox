import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as admin from 'firebase-admin';
import * as auth from 'firebase-admin/auth';
import { ApiConfigService } from '@app/common/config/api-config.service';

@Injectable()
export class FirebaseService {
  private fbApp?: admin.app.App;

  constructor(private readonly configService: ApiConfigService) {}

  /** Initialized on first use, so apps boot with placeholder credentials (tests, fresh local setups). */
  get fbAuth(): auth.Auth {
    this.fbApp ??= admin.initializeApp({
      credential: admin.credential.cert({
        clientEmail: this.configService.get('firebase_client_email'),
        privateKey: this.configService.get('firebase_private_key'),
        projectId: this.configService.get('firebase_project_id'),
      }),
    });
    return this.fbApp.auth();
  }

  async createUserByEmail(email: string, password: string): Promise<void> {
    await this.fbAuth.createUser({
      email,
      password,
    });
  }
}
