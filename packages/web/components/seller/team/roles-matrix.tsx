'use client';

import { CheckIcon, XIcon } from 'lucide-react';
import { SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Skeleton } from '@/components/ui/skeleton';
import { useRoles } from '@/lib/api/seller-team';
import { roleLabel } from '@/lib/seller/nav';

/** Plain-language names of the permissions the app knows; any other permission shows under its raw name. */
const PERMISSION_LABEL: Record<string, string> = {
  'shop.read': 'View shop details',
  'shop.manage': 'Edit shop settings',
  'shop.delete': 'Close the shop',
  'shop.export': 'Export shop data',
  'members.read': 'View team members',
  'members.manage': 'Manage team members',
  'products.read': 'View products',
  'products.write': 'Create and edit products',
  'orders.read': 'View orders',
  'orders.manage': 'Manage orders',
  'payouts.read': 'View payouts',
  'billing.manage': 'Manage billing',
  'api-keys.manage': 'Manage API keys',
  'webhooks.manage': 'Manage webhooks',
  'integrations.manage': 'Manage integrations',
  'widget.manage': 'Manage the shop widget',
  'sso.manage': 'Manage single sign-on',
};

export const permissionLabel = (permission: string): string => PERMISSION_LABEL[permission] ?? permission;

const ROLES = ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'] as const;

type Row = { permission: string; allowed: Record<(typeof ROLES)[number], boolean> };

/**
 * What each role may do (W04 AS-79, `GET /shop-roles`): roles are columns, permissions are rows, and every cell says
 * "Allowed" or "Not allowed" in words beside its icon, so the table reads without colour. The member's own role is marked.
 */
export function RolesMatrix({ myRole }: { myRole?: string }) {
  const roles = useRoles();
  if (roles.isError) return <SectionError error={roles.error} onRetry={() => void roles.refetch()} />;
  if (!roles.data) return <Skeleton aria-hidden="true" className="h-48 w-full" />;

  const matrix = roles.data;
  const rows: Row[] = matrix.permissions.map((permission) => ({
    permission,
    allowed: Object.fromEntries(ROLES.map((role) => [role, matrix.roles[role].includes(permission)])) as Row['allowed'],
  }));

  const columns: Column<Row>[] = [
    { id: 'permission', header: 'Permission', primary: true, cell: (row) => permissionLabel(row.permission) },
    ...ROLES.map<Column<Row>>((role) => ({
      id: role,
      header: role === myRole ? `${roleLabel(role)} (your role)` : roleLabel(role),
      cell: (row) =>
        row.allowed[role] ? (
          <span className="inline-flex items-center gap-1">
            <CheckIcon aria-hidden="true" className="size-4" />
            Allowed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <XIcon aria-hidden="true" className="size-4" />
            Not allowed
          </span>
        ),
    })),
  ];

  return <ResponsiveTable caption="Roles and permissions" captionHidden columns={columns} rows={rows} rowKey={(row) => row.permission} />;
}
