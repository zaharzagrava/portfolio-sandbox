import { ConfigRules } from '@app/common/config/config-rules';
import { tenancyConfigProblems } from '../domain/cell-config';

// Evaluated once at startup with every other capability's rules (S54 FR-077), when this file is loaded with the module.
ConfigRules.register({
  owner: 'tenancy',
  keys: [
    'tenancy_cells',
    'tenancy_regions',
    'tenancy_cell_pool_max',
    'tenancy_cell_connection_limit',
    'tenancy_cell_reserved_connections',
    'db_max_instances',
  ],
  validate: tenancyConfigProblems,
});
