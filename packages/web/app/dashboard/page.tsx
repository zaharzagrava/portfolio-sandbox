import { permanentRedirect } from 'next/navigation';

/** The buyer's dashboard is gone: orders live at `/orders`, selling at `/dashboard/seller` (W04 FR-013). */
export default function Page() {
  permanentRedirect('/dashboard/seller');
}
