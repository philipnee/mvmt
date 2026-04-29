import { describe, expect, it } from 'vitest';
import {
  hashApiToken,
  isApiTokenVerifier,
  normalizeApiTokenVerifierForDuplicateCheck,
  verifyApiToken,
} from '../src/utils/api-token-hash.js';

const LEGACY_SHA256_FOR_CASE_TOKEN = '68422947E634BBE26EEACDFC99FDAD68E4E5FD75DA9EB717B1DA0F710EC7B0AB';

describe('API token verifiers', () => {
  it('stores new token verifiers with scrypt', () => {
    const verifier = hashApiToken('plain-token');

    expect(verifier).toMatch(/^scrypt:v1:/);
    expect(isApiTokenVerifier(verifier)).toBe(true);
    expect(verifyApiToken('plain-token', verifier)).toBe(true);
    expect(verifyApiToken('wrong-token', verifier)).toBe(false);
  });

  it('accepts legacy SHA-256 verifiers for existing configs', () => {
    expect(isApiTokenVerifier(LEGACY_SHA256_FOR_CASE_TOKEN)).toBe(true);
    expect(verifyApiToken('case-token', LEGACY_SHA256_FOR_CASE_TOKEN)).toBe(true);
    expect(verifyApiToken('wrong-token', LEGACY_SHA256_FOR_CASE_TOKEN)).toBe(false);
    expect(normalizeApiTokenVerifierForDuplicateCheck(LEGACY_SHA256_FOR_CASE_TOKEN))
      .toBe(LEGACY_SHA256_FOR_CASE_TOKEN.toLowerCase());
  });
});
