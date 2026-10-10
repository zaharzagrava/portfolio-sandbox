/**
 * Trusted documents shipped by the mobile app and the web server (hash → query). Generated at app build time from the
 * app's .graphql files; a new app release adds entries, old entries stay until that version is unsupported. Every key
 * must be the SHA-256 (hex) of its document and every document must validate against the schema and the query limits:
 * the BFF refuses to start otherwise and names the entry (S48 FR-036, AS-39).
 */
export const PERSISTED_QUERIES: Record<string, string> = {
  ee6eda5b8f1cf4d701e08b2047cf78996a9d62a54264bbc91f4743d07b15fd3b:
    'query ProductScreen($id: ID!) { product(id: $id) { id title priceMinor currency shop { id name } recommendations { id title priceMinor currency } } }',
};
