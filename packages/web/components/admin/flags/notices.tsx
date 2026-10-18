import type { Flag } from '@marketplace-sandbox/contracts';

const BOX = 'rounded-lg border px-3 py-2 text-sm';

/** The state notice under the header (W06 AS-11, AS-34, AS-37). Killed and archived are polite status regions. */
export function StateNotice({ status }: { status: Flag['status'] }) {
  if (status === 'killed') {
    return (
      <p role="status" className={`${BOX} border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100`}>
        This flag is killed. Everyone gets the off variant until it is restored. Restoring makes it disabled; enabling it is a separate, deliberate save.
      </p>
    );
  }
  if (status === 'archived') {
    return (
      <p role="status" className={`${BOX} bg-muted`}>
        This flag is archived. It can&apos;t be edited, killed or restored.
      </p>
    );
  }
  if (status === 'disabled') {
    return (
      <p className={`${BOX} bg-muted`}>
        This flag is disabled: everyone gets the off variant. Turn on <strong>Enabled</strong> and save to start serving rules.
      </p>
    );
  }
  return null;
}

export const CLIENT_SIDE_NOTICE = "Browsers can read this flag's name, variant and value. Never put secrets in a client-side flag.";
export const EXPIRY_HELP = 'Expiry is a reminder only. An expired flag keeps working until you change or archive it.';
