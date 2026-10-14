import type { Provider } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { AUCTION_SETTINGS } from '../domain/auction-ports';
import { readAuctionSettings } from '../domain/auction-config';

/** Outside production a missing secret falls back to a fixed development value, so aliases agree across instances. */
const DEVELOPMENT_ALIAS_SECRET = 'development-only-auctions-alias-secret';

/** The typed settings snapshot (research R-14); the cross-field rules already ran at startup (`auctionsRule`). */
export const auctionSettingsProvider: Provider = {
  provide: AUCTION_SETTINGS,
  inject: [ApiConfigService],
  useFactory: (config: ApiConfigService) =>
    readAuctionSettings(
      config,
      config.get('auctions_alias_secret') || DEVELOPMENT_ALIAS_SECRET,
    ),
};
