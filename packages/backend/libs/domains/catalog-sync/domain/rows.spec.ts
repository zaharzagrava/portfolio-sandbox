import { CatalogRow, sniff } from './rows';

/** Row validation + sniffing are shared by import (CSV and JSONL) and the API's bulk endpoints. */
describe('catalog rows', () => {
  it('converts major-unit prices to minor units exactly', () => {
    expect(
      CatalogRow.parse({
        sku: 'A1',
        title: 'Cable',
        price: '12.99',
        stock: '3',
        category: 'acc',
      }).price,
    ).toBe(1299);
    expect(
      CatalogRow.parse({
        sku: 'A1',
        title: 'Cable',
        price: '0.1',
        stock: 0,
        category: 'acc',
      }).price,
    ).toBe(10);
    expect(
      CatalogRow.parse({
        sku: 'A1',
        title: 'Cable',
        price: 19,
        stock: 0,
        category: 'acc',
      }).price,
    ).toBe(1900);
    expect(
      CatalogRow.safeParse({
        sku: 'A1',
        title: 'Cable',
        price: '12.999',
        stock: 0,
        category: 'acc',
      }).success,
    ).toBe(false);
    expect(
      CatalogRow.safeParse({
        sku: 'A1',
        title: 'Cable',
        price: '-5',
        stock: 0,
        category: 'acc',
      }).success,
    ).toBe(false);
  });

  it('sniffs content, not extensions', () => {
    expect(sniff(Buffer.from('﻿sku,title,price\n'))).toBe('csv');
    expect(sniff(Buffer.from('  {"sku":"a"}\n'))).toBe('jsonl');
    expect(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe('binary'); // a zip renamed to .csv
  });
});
