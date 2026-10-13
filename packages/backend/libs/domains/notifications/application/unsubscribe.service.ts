import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { invalidUnsubscribeToken } from '../domain/errors';
import { verifyUnsubscribe } from '../domain/unsubscribe-token';
import { readNotificationsSettings } from './notifications-settings';
import { PreferencesService } from './preferences.service';

/**
 * One-click unsubscribe (FR-036). The token is bound to (user, category), signed with the dedicated notification
 * secret and never expires. `describe` changes nothing (mail scanners fetch every link); `perform` switches the
 * category off on the e-mail channel only and is safe to repeat. A bad shape, a bad MAC and an unknown category are one
 * and the same error.
 */
@Injectable()
export class UnsubscribeService {
  private readonly secret: string;

  constructor(
    private readonly preferences: PreferencesService,
    config: ApiConfigService,
  ) {
    this.secret = readNotificationsSettings(config).secret;
  }

  describe(token: string): { category: string } {
    return { category: this.parse(token).category };
  }

  async perform(token: string): Promise<{ unsubscribed: string }> {
    const { userId, category } = this.parse(token);
    await this.preferences.setCell(userId, category, 'email', false);
    return { unsubscribed: category };
  }

  private parse(token: string) {
    const parsed = verifyUnsubscribe(token, this.secret);
    if (!parsed) throw invalidUnsubscribeToken();
    return parsed;
  }
}
