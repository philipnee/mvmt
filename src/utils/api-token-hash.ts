import crypto from 'crypto';

const SCRYPT_PREFIX = 'scrypt:v1';
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_OPTIONS = {
  cost: 16_384,
  blockSize: 8,
  parallelization: 1,
  maxmem: 64 * 1024 * 1024,
} as const;
const LEGACY_SHA256_RE = /^[0-9a-f]{64}$/i;
const SCRYPT_RE = /^scrypt:v1:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/;

export function hashApiToken(token: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(token, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
  return `${SCRYPT_PREFIX}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function verifyApiToken(token: string, verifier: string): boolean {
  const scrypt = parseScryptVerifier(verifier);
  if (scrypt) {
    const candidate = crypto.scryptSync(token, scrypt.salt, scrypt.hash.length, SCRYPT_OPTIONS);
    return timingSafeBufferEqual(candidate, scrypt.hash);
  }

  if (isLegacySha256Verifier(verifier)) {
    return timingSafeHexEqual(legacySha256TokenHash(token), verifier);
  }

  return false;
}

export function isApiTokenVerifier(value: string): boolean {
  return isLegacySha256Verifier(value) || parseScryptVerifier(value) !== undefined;
}

export function normalizeApiTokenVerifierForDuplicateCheck(value: string): string {
  return isLegacySha256Verifier(value) ? value.toLowerCase() : value;
}

function parseScryptVerifier(value: string): { salt: Buffer; hash: Buffer } | undefined {
  const match = SCRYPT_RE.exec(value);
  if (!match) return undefined;
  const salt = Buffer.from(match[1], 'base64url');
  const hash = Buffer.from(match[2], 'base64url');
  if (salt.length < 16 || hash.length !== SCRYPT_KEY_LENGTH) return undefined;
  return { salt, hash };
}

function isLegacySha256Verifier(value: string): boolean {
  return LEGACY_SHA256_RE.test(value);
}

function legacySha256TokenHash(value: string): string {
  // Legacy compatibility only: configs written before scrypt verifiers
  // stored SHA-256 of high-entropy API tokens. New tokens never use this.
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function timingSafeBufferEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
