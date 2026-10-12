/**
 * The event contracts of `tenancy` as a leaf module (`@app/domains/tenancy/contracts`): it imports no other domain, so a
 * domain that tenancy itself depends on (identity consuming `tenancy.shop_created`) can read them without going through
 * the barrel, which would close an import cycle. Same definitions as the barrel exports.
 */
export {
  InviteCreated,
  MemberAdded,
  MemberRemoved,
  MemberRoleChanged,
  ShopCellMoved,
  ShopCreated,
  ShopDeleted,
  ShopOffboardingCancelled,
  ShopOffboardingStarted,
  ShopPlanChanged,
  ShopStatusChanged,
  ShopUpdated,
  ShopVerificationChanged,
} from './domain/events';
