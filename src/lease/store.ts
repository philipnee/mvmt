import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hashApiToken, verifyApiToken } from '../utils/api-token-hash.js';
import { TOKEN_PATH } from '../utils/token.js';
import { isExpired } from '../utils/token-ttl.js';

export const LEASES_PATH = path.join(os.homedir(), '.mvmt', '.leases.json');
export const DEFAULT_LEASE_TTL = '24h';

export type LeasePermission = 'read' | 'upload';

export interface LeaseRecord {
  id: string;
  label: string;
  path: string;
  permissions: LeasePermission[];
  tokenHash: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  downloadCount: number;
  uploadCount: number;
}

interface LeaseStoreFile {
  version: 1;
  leases: LeaseRecord[];
}

export interface CreatedLease {
  record: LeaseRecord;
  token: string;
}

export function defaultLeasesPath(tokenPath: string | undefined = TOKEN_PATH): string {
  if (tokenPath === TOKEN_PATH) return LEASES_PATH;
  return path.join(path.dirname(tokenPath), '.leases.json');
}

export function createLease(
  storePath: string,
  input: { label: string; path: string; expiresAt?: string; permissions?: LeasePermission[] },
): CreatedLease {
  const store = readLeaseStore(storePath);
  const token = `mvmt_l_${crypto.randomBytes(32).toString('base64url')}`;
  const record: LeaseRecord = {
    id: uniqueLeaseId(store),
    label: input.label,
    path: input.path,
    permissions: input.permissions ?? ['read'],
    tokenHash: hashApiToken(token),
    createdAt: new Date().toISOString(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    downloadCount: 0,
    uploadCount: 0,
  };
  store.leases.push(record);
  writeLeaseStore(storePath, store);
  return { record, token };
}

export function listLeases(storePath: string): LeaseRecord[] {
  return readLeaseStore(storePath).leases;
}

export function findLease(storePath: string, id: string): LeaseRecord | undefined {
  return readLeaseStore(storePath).leases.find((lease) => lease.id === id);
}

export function revokeLease(storePath: string, id: string): boolean {
  const store = readLeaseStore(storePath);
  const index = store.leases.findIndex((lease) => lease.id === id);
  if (index < 0) return false;
  store.leases[index] = {
    ...store.leases[index],
    revokedAt: store.leases[index].revokedAt ?? new Date().toISOString(),
  };
  writeLeaseStore(storePath, store);
  return true;
}

export function recordLeaseUse(storePath: string, id: string, options: { downloaded?: boolean; uploaded?: boolean } = {}): void {
  const store = readLeaseStore(storePath);
  const index = store.leases.findIndex((lease) => lease.id === id);
  if (index < 0) return;
  const lease = store.leases[index];
  store.leases[index] = {
    ...lease,
    lastUsedAt: new Date().toISOString(),
    downloadCount: (lease.downloadCount ?? 0) + (options.downloaded ? 1 : 0),
    uploadCount: (lease.uploadCount ?? 0) + (options.uploaded ? 1 : 0),
  };
  writeLeaseStore(storePath, store);
}

export function validateLeaseToken(lease: LeaseRecord, token: string | undefined): boolean {
  return Boolean(token && verifyApiToken(token, lease.tokenHash));
}

export function leaseUnavailableReason(lease: LeaseRecord, now = Date.now()): 'expired' | 'revoked' | undefined {
  if (lease.revokedAt) return 'revoked';
  if (isExpired(lease.expiresAt, now)) return 'expired';
  return undefined;
}

export function leaseAllows(lease: LeaseRecord, permission: LeasePermission): boolean {
  return lease.permissions.includes(permission);
}

function readLeaseStore(storePath: string): LeaseStoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as LeaseStoreFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.leases)) return emptyStore();
    return {
      version: 1,
      leases: parsed.leases.map((lease) => ({
        ...lease,
        permissions: lease.permissions?.filter(isLeasePermission) ?? ['read'],
        downloadCount: lease.downloadCount ?? 0,
        uploadCount: lease.uploadCount ?? 0,
      })),
    };
  } catch {
    return emptyStore();
  }
}

function writeLeaseStore(storePath: string, store: LeaseStoreFile): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(storePath, 0o600);
}

function emptyStore(): LeaseStoreFile {
  return { version: 1, leases: [] };
}

function uniqueLeaseId(store: LeaseStoreFile): string {
  const existing = new Set(store.leases.map((lease) => lease.id));
  for (;;) {
    const id = crypto.randomBytes(12).toString('base64url');
    if (!existing.has(id)) return id;
  }
}

function isLeasePermission(value: unknown): value is LeasePermission {
  return value === 'read' || value === 'upload';
}
