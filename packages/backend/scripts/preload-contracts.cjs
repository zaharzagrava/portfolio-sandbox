// The contracts package is ESM ("type": "module") and Node loads it natively, as in the built API.
// ts-node's require hook refuses ESM-typed .ts files (ERR_REQUIRE_ESM), so load the package here,
// before ts-node registers; later requires of it hit the module cache.
require('../../contracts/index.ts');
