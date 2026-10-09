/**
 * Trusted documents shipped by the mobile app (hash → query). Generated at app build time from the
 * app's .graphql files; a new app release adds entries, old entries stay until that version is unsupported.
 */
export const PERSISTED_QUERIES: Record<string, string> = {
  '89fc92a2fb9d8f7fea91d081e3327108d8943005f5b3326f2992320fb669bc10':
    'query ProductScreen($id: ID!) { product(id: $id) { id title price stock shop { id name } recommendations { id title price } } }',
};
