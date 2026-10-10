import { PolicyRegistry } from './policy-registry';

/**
 * The compile-time half of AS-72 is `policy-names.type-spec.ts` (checked by `tsc --noEmit`). This is the runtime half:
 * a name that slipped past the compiler (a cast, a string built at run time) is refused when it is looked up.
 */
describe('S50 policy names', () => {
  it('S50 AS-72: an undeclared name is refused at run time; the two defaults are declared', () => {
    const registry = new PolicyRegistry();
    expect(() => registry.get('undeclared')).toThrow(/not declared/);
    expect(registry.has('default.read')).toBe(true);
    expect(registry.has('default.write')).toBe(true);
    expect(registry.names().sort()).toEqual(['default.read', 'default.write']);
  });
});
