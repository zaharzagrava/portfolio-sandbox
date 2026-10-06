/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const crypto = require('crypto');
const { log, randomInt, pick, chunk } = require('./common');

/** Marker tag so a later run can delete exactly the docs it indexed. */
const LOADTEST_TAG = 'loadtest';
const PRODUCTS_INDEX = 'products';
const EMBEDDING_DIMS = 64; // PRODUCT_EMBEDDING_DIMS in product.model.ts

const CATALOG = {
  electronics: {
    brands: ['Apple', 'Samsung', 'Sony', 'Xiaomi', 'Lenovo', 'Dell', 'Asus', 'Bose'],
    nouns: ['iphone', 'laptop', 'headphones', 'smartwatch', 'tablet', 'monitor', 'keyboard', 'camera', 'speaker', 'charger'],
    price: [1500, 250000],
  },
  fashion: {
    brands: ['Nike', 'Adidas', 'Zara', 'Uniqlo', 'Levis', 'Puma', 'Gucci', 'NorthFace'],
    nouns: ['coat', 'jacket', 'sneakers', 'jeans', 'hoodie', 'dress', 'boots', 'scarf', 'shirt', 'backpack'],
    price: [1000, 60000],
  },
  home: {
    brands: ['Ikea', 'Philips', 'Dyson', 'Tefal', 'Bosch', 'Braun'],
    nouns: ['lamp', 'vacuum', 'kettle', 'blender', 'sofa', 'pillow', 'blanket', 'chair', 'desk', 'mirror'],
    price: [900, 90000],
  },
  sports: {
    brands: ['Decathlon', 'Wilson', 'Garmin', 'Salomon', 'Asics', 'Reebok'],
    nouns: ['bike', 'dumbbells', 'yoga mat', 'tent', 'helmet', 'racket', 'treadmill', 'skis', 'ball', 'bottle'],
    price: [700, 150000],
  },
  books: {
    brands: ['Penguin', 'OReilly', 'HarperCollins', 'Manning', 'Vintage'],
    nouns: ['novel', 'cookbook', 'guide', 'atlas', 'biography', 'textbook', 'comic', 'poetry'],
    price: [500, 8000],
  },
  beauty: {
    brands: ['Loreal', 'Nivea', 'Dove', 'Clinique', 'Olay'],
    nouns: ['perfume', 'shampoo', 'serum', 'lipstick', 'moisturizer', 'sunscreen', 'razor'],
    price: [400, 20000],
  },
  toys: {
    brands: ['Lego', 'Hasbro', 'Mattel', 'Playmobil', 'Nintendo'],
    nouns: ['puzzle', 'drone', 'doll', 'board game', 'robot', 'console', 'blocks'],
    price: [800, 60000],
  },
  garden: {
    brands: ['Gardena', 'Husqvarna', 'Makita', 'Stihl'],
    nouns: ['lawn mower', 'hose', 'grill', 'shovel', 'planter', 'drill', 'saw'],
    price: [1200, 120000],
  },
};

const ADJECTIVES = [
  'winter', 'wireless', 'premium', 'compact', 'vintage', 'waterproof', 'ultra', 'classic', 'smart',
  'lightweight', 'organic', 'portable', 'ergonomic', 'nordic', 'pro', 'mini', 'eco', 'deluxe', 'retro', 'carbon',
];

const CATEGORY_NAMES = Object.keys(CATALOG);
const ALL_BRANDS = CATEGORY_NAMES.flatMap((c) => CATALOG[c].brands);

/** Same algorithm as ElasticsearchService#stubEmbed so k-NN queries hit. */
function stubEmbed(text) {
  const vec = new Array(EMBEDDING_DIMS).fill(0);
  const normalized = text.toLowerCase();
  for (let i = 0; i < normalized.length; i++) {
    vec[i % EMBEDDING_DIMS] += (normalized.charCodeAt(i) % 31) / 31;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function generateProduct(sellerId) {
  const category = pick(CATEGORY_NAMES);
  const { brands, nouns, price } = CATALOG[category];
  const brand = pick(brands);
  const noun = pick(nouns);
  const adjective = pick(ADJECTIVES);
  const title = `${brand} ${adjective} ${noun} ${randomInt(1, 9)}${pick(['', 'X', 'S', ' Pro', ' Max'])}`.trim();

  return {
    id: crypto.randomUUID(),
    sellerId,
    title,
    description: `A ${adjective} ${noun} by ${brand}. Great for everyday ${category} needs, ${pick(ADJECTIVES)} and ${pick(ADJECTIVES)} design.`,
    brand,
    category,
    price: randomInt(price[0], price[1]),
    rating: Math.round((1 + Math.random() * 4) * 10) / 10,
    tags: [category, noun, adjective, LOADTEST_TAG],
    quantity: randomInt(0, 500),
    embedding: stubEmbed(title),
  };
}

function withTypo(word) {
  if (word.length < 4) return word;
  const i = randomInt(1, word.length - 2);
  switch (randomInt(0, 2)) {
    case 0: return word.slice(0, i) + word.slice(i + 1); // deletion
    case 1: return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2); // transposition
    default: return word.slice(0, i) + pick('aeiou') + word.slice(i + 1); // substitution
  }
}

/**
 * Search terms drawn from the same vocabulary as the catalog, ~30% with a
 * typo (exercises fuzziness: AUTO) and ~15% short prefixes (autocomplete).
 */
function generateQueries(count = 2000) {
  const queries = new Set();
  while (queries.size < count) {
    const category = pick(CATEGORY_NAMES);
    const noun = pick(CATALOG[category].nouns);
    const roll = Math.random();

    let q;
    if (roll < 0.3) q = withTypo(noun);
    else if (roll < 0.45) q = noun.slice(0, randomInt(2, Math.max(2, noun.length - 1)));
    else if (roll < 0.7) q = `${pick(ADJECTIVES)} ${noun}`;
    else if (roll < 0.85) q = `${pick(CATALOG[category].brands)} ${noun}`;
    else q = noun;

    queries.add(q.toLowerCase());
  }
  return [...queries];
}

async function insertProducts(pool, products, batchSize = 5000) {
  for (const [i, batch] of chunk(products, batchSize).entries()) {
    await pool.query(
      `INSERT INTO "Product"
         (id, title, description, brand, category, price, rating, tags, quantity,
          version, embedding, "sellerId", "createdAt", "updatedAt")
       SELECT id, title, description, brand, category, price, rating, tags::jsonb, quantity,
              0, embedding::jsonb, "sellerId", NOW(), NOW()
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[],
                   $7::float8[], $8::text[], $9::int[], $10::text[], $11::uuid[])
         AS t(id, title, description, brand, category, price, rating, tags, quantity, embedding, "sellerId")`,
      [
        batch.map((p) => p.id),
        batch.map((p) => p.title),
        batch.map((p) => p.description),
        batch.map((p) => p.brand),
        batch.map((p) => p.category),
        batch.map((p) => p.price),
        batch.map((p) => p.rating),
        batch.map((p) => JSON.stringify(p.tags)),
        batch.map((p) => p.quantity),
        batch.map((p) => JSON.stringify(p.embedding)),
        batch.map((p) => p.sellerId),
      ],
    );
    log(`  products (postgres): ${Math.min((i + 1) * batchSize, products.length)}/${products.length}`);
  }
}

/**
 * Seeded rows bypass ProductService#create, so no products.events outbox
 * row exists and search-indexer never sees them - index them directly.
 */
async function indexProducts(esClient, products, batchSize = 2000) {
  const exists = await esClient.indices.exists({ index: PRODUCTS_INDEX });
  if (!exists) {
    throw new Error(
      `Elasticsearch index "${PRODUCTS_INDEX}" is missing - start the core app once so ElasticsearchService creates it with its analyzers, then re-run the seed.`,
    );
  }

  for (const [i, batch] of chunk(products, batchSize).entries()) {
    const operations = batch.flatMap((p) => [
      { index: { _index: PRODUCTS_INDEX, _id: p.id } },
      {
        title: p.title,
        description: p.description,
        brand: p.brand,
        category: p.category,
        price: p.price,
        rating: p.rating,
        tags: p.tags,
        embedding: p.embedding,
      },
    ]);

    const response = await esClient.bulk({ operations, refresh: false });
    if (response.errors) {
      const firstError = response.items.find((item) => item.index?.error)?.index?.error;
      throw new Error(`Elasticsearch bulk index failed: ${JSON.stringify(firstError)}`);
    }
    log(`  products (elasticsearch): ${Math.min((i + 1) * batchSize, products.length)}/${products.length}`);
  }

  await esClient.indices.refresh({ index: PRODUCTS_INDEX });
}

async function deleteIndexedLoadtestProducts(esClient) {
  const exists = await esClient.indices.exists({ index: PRODUCTS_INDEX });
  if (!exists) return;
  const response = await esClient.deleteByQuery({
    index: PRODUCTS_INDEX,
    query: { term: { tags: LOADTEST_TAG } },
    conflicts: 'proceed',
    refresh: true,
  });
  if (response.deleted) log(`deleted ${response.deleted} load-test docs from Elasticsearch`);
}

module.exports = {
  CATEGORY_NAMES,
  ALL_BRANDS,
  generateProduct,
  generateQueries,
  insertProducts,
  indexProducts,
  deleteIndexedLoadtestProducts,
};
