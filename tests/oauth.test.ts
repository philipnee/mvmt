import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { OAuthError, OAuthStore, verifyPkce } from '../src/server/oauth.js';

function pkcePair(verifier = crypto.randomBytes(32).toString('base64url')): {
  verifier: string;
  challenge: string;
} {
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('verifyPkce', () => {
  it('accepts a matching S256 verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkce(challenge, 'S256', verifier)).toBe(true);
  });

  it('rejects an incorrect S256 verifier', () => {
    const { challenge } = pkcePair();
    expect(verifyPkce(challenge, 'S256', 'not-the-verifier')).toBe(false);
  });

  it('accepts a matching plain verifier', () => {
    expect(verifyPkce('abc', 'plain', 'abc')).toBe(true);
    expect(verifyPkce('abc', 'plain', 'abd')).toBe(false);
  });
});

describe('OAuthStore', () => {
  it('issues an auth code and exchanges it for a bearer token', () => {
    const store = new OAuthStore();
    const { verifier, challenge } = pkcePair();

    const code = store.issueCode({
      clientId: 'claude',
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });

    const token = store.consumeCode({
      code: code.code,
      clientId: 'claude',
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeVerifier: verifier,
    });

    expect(token.token).toBeTypeOf('string');
    expect(token.token.length).toBeGreaterThan(20);
    expect(store.validateAccessToken(`Bearer ${token.token}`)?.token).toBe(token.token);
  });

  it('rejects code reuse', () => {
    const store = new OAuthStore();
    const { verifier, challenge } = pkcePair();
    const code = store.issueCode({
      clientId: 'claude',
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });

    store.consumeCode({
      code: code.code,
      clientId: 'claude',
      redirectUri: 'https://claude.ai/cb',
      codeVerifier: verifier,
    });

    expect(() =>
      store.consumeCode({
        code: code.code,
        clientId: 'claude',
        redirectUri: 'https://claude.ai/cb',
        codeVerifier: verifier,
      }),
    ).toThrow(OAuthError);
  });

  it('rejects a PKCE mismatch', () => {
    const store = new OAuthStore();
    const { challenge } = pkcePair();
    const code = store.issueCode({
      clientId: 'claude',
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });

    expect(() =>
      store.consumeCode({
        code: code.code,
        clientId: 'claude',
        redirectUri: 'https://claude.ai/cb',
        codeVerifier: 'wrong-verifier',
      }),
    ).toThrow(/PKCE/);
  });

  it('rejects a redirect_uri mismatch', () => {
    const store = new OAuthStore();
    const { verifier, challenge } = pkcePair();
    const code = store.issueCode({
      clientId: 'claude',
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });

    expect(() =>
      store.consumeCode({
        code: code.code,
        clientId: 'claude',
        redirectUri: 'https://evil.example/cb',
        codeVerifier: verifier,
      }),
    ).toThrow(/Redirect URI/);
  });

  it('expires access tokens', () => {
    let now = 1_000_000;
    const store = new OAuthStore({ tokenTtlMs: 1000, now: () => now });
    const token = store.issueAccessToken({ clientId: 'claude' });

    expect(store.validateAccessToken(`Bearer ${token.token}`)).toBeDefined();
    now += 2000;
    expect(store.validateAccessToken(`Bearer ${token.token}`)).toBeUndefined();
  });

  it('expires authorization codes', () => {
    let now = 1_000_000;
    const store = new OAuthStore({ codeTtlMs: 1000, now: () => now });
    const { verifier, challenge } = pkcePair();
    const code = store.issueCode({
      clientId: 'claude',
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });
    now += 2000;

    expect(() =>
      store.consumeCode({
        code: code.code,
        clientId: 'claude',
        redirectUri: 'https://claude.ai/cb',
        codeVerifier: verifier,
      }),
    ).toThrow(/expired/);
  });

  it('validateAccessToken ignores malformed or missing headers', () => {
    const store = new OAuthStore();
    expect(store.validateAccessToken(undefined)).toBeUndefined();
    expect(store.validateAccessToken('Basic xxx')).toBeUndefined();
    expect(store.validateAccessToken('Bearer nope')).toBeUndefined();
  });
});
