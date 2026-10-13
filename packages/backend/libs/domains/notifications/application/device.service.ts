import { Inject, Injectable } from '@nestjs/common';
import type {
  Device,
  DeviceList,
  RegisterDeviceRequest,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { deviceNotFound } from '../domain/errors';
import {
  DEVICE_REPOSITORY,
  type DeviceRecord,
  type DeviceRepository,
} from '../domain/ports';
import { RecipientViewService } from './recipient-view.service';

/** At most this many devices per user; registering one more evicts the least recently seen (FR-020). */
export const DEVICE_CAP = 10;

const toDevice = (d: DeviceRecord): Device => ({
  id: d.id,
  platform: d.platform,
  lastSeenAt: d.lastSeenAt.toISOString(),
});

/**
 * Push devices: registered, listed without their tokens, moved to the latest registering user, removed by their own id
 * and only by their owner. The token never leaves this domain and never appears in a URL (FR-020).
 */
@Injectable()
export class DeviceService {
  constructor(
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepository,
    private readonly views: RecipientViewService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<DeviceList> {
    return { items: (await this.devices.list(userId)).map(toDevice) };
  }

  /** `created` tells the controller `201` from `200`. */
  async register(
    userId: string,
    request: RegisterDeviceRequest,
  ): Promise<{ device: Device; created: boolean }> {
    const { device, created, previousUserId } = await this.devices.register(
      { userId, token: request.token, platform: request.platform },
      DEVICE_CAP,
      this.clock.now(),
    );
    await this.views.invalidate(
      previousUserId ? [userId, previousUserId] : userId,
    );
    return { device: toDevice(device), created };
  }

  /** `404 device_not_found` for an unknown id and for another user's id alike. */
  async remove(userId: string, deviceId: string): Promise<void> {
    if (!(await this.devices.remove(userId, deviceId))) throw deviceNotFound();
    await this.views.invalidate(userId);
  }

  /** Tokens a provider reported dead. */
  async removeByTokens(tokens: string[]): Promise<void> {
    const owners = new Set<string>();
    for (const token of tokens) {
      const owner = await this.devices.removeByToken(token);
      if (owner) owners.add(owner);
    }
    await this.views.invalidate([...owners]);
  }
}
