'use client';

import { create } from 'qrcode';
import { useMemo } from 'react';

export const QR_ALT = 'QR code for your authenticator app. The setup key below is the same secret.';

const QUIET_ZONE = 4;

/**
 * The enrolment QR code as an SVG element tree built from the module matrix (R-08): nothing is injected as HTML, the
 * secret never leaves this component's props, and the picture scales down with its container so it never overflows.
 */
export function QrCode({ value }: { value: string }) {
  const { size, path } = useMemo(() => {
    const { modules } = create(value, { errorCorrectionLevel: 'M' });
    const count = modules.size;
    let d = '';
    for (let row = 0; row < count; row += 1)
      for (let col = 0; col < count; col += 1)
        if (modules.get(row, col)) d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    return { size: count + QUIET_ZONE * 2, path: d };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={QR_ALT}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="h-auto w-full max-w-56 rounded-md border bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
