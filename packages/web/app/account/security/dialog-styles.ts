/** The destructive button variant's red on its tint is 4.0:1 (axe needs 4.5:1 for 14 px text); this keeps it readable. */
export const DESTRUCTIVE_TEXT = 'text-red-700 hover:text-red-800 dark:text-red-300 dark:hover:text-red-200';

/** At <= 640 px the account dialogs are bottom sheets that fill the width (W01 AS-53); from 640 px they are centred modals. */
export const SHEET_DIALOG =
  'max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-h-[90dvh] overflow-y-auto sm:max-w-md';
