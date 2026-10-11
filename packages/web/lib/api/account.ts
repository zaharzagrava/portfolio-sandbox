import {
  federatedIdentitySchema,
  mfaEnrollSchema,
  mfaRecoveryCodesSchema,
  mfaStatusSchema,
  oidcProviderSchema,
  oidcStartSchema,
  sessionListItemSchema,
} from '@marketplace-sandbox/contracts';
import { z } from 'zod';
import { apiClient } from './client';
import { parseBody } from './parse';

/**
 * Signed-in account calls. They go same-origin through the BFF forwarder, which attaches the identity; every success body
 * is parsed with its contracts schema. Failures throw the axios error (`problemFromError` reads it).
 */

export const getMfaStatus = async () => parseBody(mfaStatusSchema, (await apiClient.get('/api/auth/mfa')).data);

export const enrollMfa = async () => parseBody(mfaEnrollSchema, (await apiClient.post('/api/auth/mfa/enroll', {})).data);

export const confirmMfa = async (code: string) =>
  parseBody(mfaRecoveryCodesSchema, (await apiClient.post('/api/auth/mfa/confirm', { code })).data);

export const regenerateRecoveryCodes = async (code: string) =>
  parseBody(mfaRecoveryCodesSchema, (await apiClient.post('/api/auth/mfa/recovery-codes/regenerate', { code })).data);

export async function disableMfa(code: string): Promise<void> {
  await apiClient.post('/api/auth/mfa/disable', { code });
}

export const listSessions = async () =>
  parseBody(z.array(sessionListItemSchema), (await apiClient.get('/api/auth/sessions')).data);

export async function revokeSession(sessionId: string): Promise<void> {
  await apiClient.delete(`/api/auth/sessions/${encodeURIComponent(sessionId)}`);
}

export const logoutAll = async () =>
  parseBody(z.object({ revokedSessions: z.number() }).passthrough(), (await apiClient.post('/api/auth/logout-all', {})).data);

export const listIdentities = async () =>
  parseBody(z.array(federatedIdentitySchema), (await apiClient.get('/api/auth/identities')).data);

export async function unlinkIdentity(identityId: string): Promise<void> {
  await apiClient.delete(`/api/auth/identities/${encodeURIComponent(identityId)}`);
}

export const listOidcProviders = async () =>
  parseBody(z.array(oidcProviderSchema), (await apiClient.get('/api/auth/oidc/providers')).data);

export const startOidc = async (returnTo: string) =>
  parseBody(oidcStartSchema, (await apiClient.post('/api/auth/oidc/google/start', { returnTo }, { anonymous: true })).data);

export const startOidcLink = async (input: { returnTo: string; code?: string }) =>
  parseBody(oidcStartSchema, (await apiClient.post('/api/auth/oidc/google/link/start', input)).data);
