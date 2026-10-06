import { apiClient } from './client';

/** Feature flags (SD-34) as stored by the admin API (`FeatureFlag` row). */
export interface FeatureFlag {
  key: string;
  description: string | null;
  enabled: boolean;
  variants: { key: string; value: unknown }[];
  defaultVariant: string;
  offVariant: string;
  owner: string;
  version: number;
  updatedAt: string;
}

/** A plain on/off flag: enabled → "on" for everyone, killed/disabled → "off". */
export function booleanFlag(description: string, owner: string) {
  return {
    description,
    enabled: true,
    variants: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    defaultVariant: 'on',
    offVariant: 'off',
    rules: [],
    owner,
  };
}

export const adminApi = {
  async listFlags(): Promise<FeatureFlag[]> {
    return (await apiClient.get('/api/admin/flags')).data;
  },

  async createFlag(payload: { key: string; description: string; owner: string }): Promise<void> {
    await apiClient.put(`/api/admin/flags/${encodeURIComponent(payload.key)}`, booleanFlag(payload.description, payload.owner));
  },

  /** Kill switch: forces the off variant everywhere within seconds (rules are kept). */
  async killFlag(key: string): Promise<void> {
    await apiClient.post(`/api/admin/flags/${encodeURIComponent(key)}/kill`);
  },
};
