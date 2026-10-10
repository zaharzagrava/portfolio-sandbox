import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall } from '@app/domains/identity';
import { AutocompleteService } from '../application/autocomplete.service';

@ApiTags('search')
@Controller('suggest')
export class AutocompleteController {
  constructor(private readonly autocomplete: AutocompleteService) {}

  /**
   * Per keystroke. Anonymous and identical for everyone → CDN-cacheable for a
   * minute: popular prefixes ("iph", "airp") are answered at the edge. Clients
   * debounce ~120 ms and abort stale requests (FE phase 2).
   */
  @Firewall({ anonymous: true })
  @Header('Cache-Control', 'public, max-age=60, s-maxage=60')
  @Get()
  suggest(@Query('q') q = '') {
    return this.autocomplete.suggest(q);
  }
}
