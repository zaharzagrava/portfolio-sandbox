import { ElasticsearchService } from './elasticsearch.service';

const serviceWith = (values: Record<string, unknown>) =>
  new ElasticsearchService({
    get: (key: string) => values[key],
  } as never);

describe('products index refresh interval (J02 H9..H11)', () => {
  it('S32 G-26: follows the search_refresh_interval setting', () => {
    const service = serviceWith({
      elasticsearch_node: 'http://localhost:9200',
      search_refresh_interval: '1s',
    });
    expect(service.productsIndexDefinition().settings.refresh_interval).toBe(
      '1s',
    );
  });

  it('S32 G-26: keeps 5s when the setting is absent', () => {
    const service = serviceWith({
      elasticsearch_node: 'http://localhost:9200',
    });
    expect(service.productsIndexDefinition().settings.refresh_interval).toBe(
      '5s',
    );
  });
});
