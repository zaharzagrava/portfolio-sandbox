import { permanentRedirect } from 'next/navigation';

/** Account settings moved to Account security (W04 FR-013). */
export default function Page() {
  permanentRedirect('/account/security');
}
