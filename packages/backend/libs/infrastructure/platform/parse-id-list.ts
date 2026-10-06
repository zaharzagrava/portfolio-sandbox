import { BadRequestException } from '@nestjs/common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?ids=a,b,c` for batch-read endpoints: unique valid UUIDs, 1–100 of them, or 400. */
export const parseIdList = (raw: string | undefined, max = 100): string[] => {
  const ids = [...new Set((raw ?? '').split(',').filter((id) => UUID.test(id)))];
  if (ids.length === 0 || ids.length > max) throw new BadRequestException(`ids: 1-${max} UUIDs`);
  return ids;
};
