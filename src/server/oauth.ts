import crypto from 'crypto';
import type { Request } from 'express';

export type CodeChallengeMethod = 'S256' | 'plain';

export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  resource?: string;
  codeChallenge: string;
  codeChallengeMethod: CodeChallengeMethod;
  scope?: string;
  expiresAt: number;
  consumed: boolean;
}

export interface AccessToken {
  token: string;
  clientId: string;
  scope?: string;
  expiresAt: number;
}

export interface IssueCodeInput {
  clientId: string;
  redirectUri: string;
  resource?: string;
  codeChallenge: string;
  codeChallengeMethod: CodeChallengeMethod;
  scope?: string;
}

export interface ConsumeCodeInput {
  code: string;
  clientId: string;
  redirectUri: string;
  resource?: string;
  codeVerifier: string;
}

export interface OAuthStoreOptions {
  codeTtlMs?: number;
  tokenTtlMs?: number;
  accessTokenSecret?: string;
  now?: () => number;
}

const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_PREFIX = 'mvmtv1';

export class OAuthStore {
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly codeTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly accessTokenSecret: string;
  private readonly now: () => number;

  constructor(options: OAuthStoreOptions = {}) {
    this.codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.accessTokenSecret = options.accessTokenSecret ?? crypto.randomBytes(32).toString('base64url');
    this.now = options.now ?? Date.now;
  }

  get tokenTtlSeconds(): number {
    return Math.floor(this.tokenTtlMs / 1000);
  }

  issueCode(input: IssueCodeInput): AuthorizationCode {
    const code = crypto.randomBytes(32).toString('base64url');
    const entry: AuthorizationCode = {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      resource: input.resource,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      scope: input.scope,
      expiresAt: this.now() + this.codeTtlMs,
      consumed: false,
    };
    this.codes.set(code, entry);
    return entry;
  }

  consumeCode(input: ConsumeCodeInput): AccessToken {
    const entry = this.codes.get(input.code);
    if (!entry) throw new OAuthError('invalid_grant', 'Authorization code not found');

    if (entry.consumed) {
      this.codes.delete(input.code);
      throw new OAuthError('invalid_grant', 'Authorization code already used');
    }
    if (entry.expiresAt < this.now()) {
      this.codes.delete(input.code);
      throw new OAuthError('invalid_grant', 'Authorization code expired');
    }
    if (entry.clientId !== input.clientId) {
      throw new OAuthError('invalid_grant', 'Client mismatch for authorization code');
    }
    if (entry.redirectUri !== input.redirectUri) {
      throw new OAuthError('invalid_grant', 'Redirect URI mismatch for authorization code');
    }
    if (entry.resource && entry.resource !== input.resource) {
      throw new OAuthError('invalid_grant', 'Resource mismatch for authorization code');
    }
    if (!verifyPkce(entry.codeChallenge, entry.codeChallengeMethod, input.codeVerifier)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed');
    }

    entry.consumed = true;
    this.codes.delete(input.code);

    return this.issueAccessToken({ clientId: entry.clientId, scope: entry.scope });
  }

  issueAccessToken(input: { clientId: string; scope?: string }): AccessToken {
    const expiresAt = this.now() + this.tokenTtlMs;
    const payload = Buffer.from(
      JSON.stringify({
        clientId: input.clientId,
        scope: input.scope,
        expiresAt,
      }),
      'utf-8',
    ).toString('base64url');
    const signature = crypto.createHmac('sha256', this.accessTokenSecret).update(payload).digest('base64url');
    const token = `${ACCESS_TOKEN_PREFIX}.${payload}.${signature}`;

    return {
      token,
      clientId: input.clientId,
      scope: input.scope,
      expiresAt,
    };
  }

  validateAccessToken(authHeader: string | undefined): AccessToken | undefined {
    if (!authHeader) return undefined;
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return undefined;
    const provided = parts[1];
    return this.parseAccessToken(provided);
  }

  cleanup(): void {
    const now = this.now();
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt < now || entry.consumed) this.codes.delete(code);
    }
  }

  private parseAccessToken(token: string): AccessToken | undefined {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== ACCESS_TOKEN_PREFIX) return undefined;

    const payload = parts[1];
    const signature = parts[2];
    const expectedSignature = crypto.createHmac('sha256', this.accessTokenSecret).update(payload).digest('base64url');
    if (!timingSafeStringEquals(signature, expectedSignature)) return undefined;

    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
        clientId?: unknown;
        scope?: unknown;
        expiresAt?: unknown;
      };
      if (typeof decoded.clientId !== 'string') return undefined;
      if (decoded.scope !== undefined && typeof decoded.scope !== 'string') return undefined;
      if (typeof decoded.expiresAt !== 'number' || !Number.isFinite(decoded.expiresAt)) return undefined;
      if (decoded.expiresAt < this.now()) return undefined;

      return {
        token,
        clientId: decoded.clientId,
        scope: decoded.scope,
        expiresAt: decoded.expiresAt,
      };
    } catch {
      return undefined;
    }
  }
}

export class OAuthError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'invalid_grant'
      | 'unauthorized_client'
      | 'unsupported_grant_type'
      | 'invalid_client'
      | 'access_denied'
      | 'server_error',
    message: string,
  ) {
    super(message);
  }
}

export function verifyPkce(
  challenge: string,
  method: CodeChallengeMethod,
  verifier: string,
): boolean {
  if (!verifier) return false;
  if (method === 'plain') return timingSafeStringEquals(challenge, verifier);
  const hashed = crypto.createHash('sha256').update(verifier).digest();
  const expected = hashed.toString('base64url');
  return timingSafeStringEquals(expected, challenge);
}

function timingSafeStringEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function getBaseUrl(req: Request): string {
  const forwardedProto = pickHeader(req.headers['x-forwarded-proto']);
  const forwardedHost = pickHeader(req.headers['x-forwarded-host']);
  const host = forwardedHost ?? pickHeader(req.headers.host) ?? 'localhost';
  const proto = forwardedProto ?? (isLocalHost(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

function pickHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === 'string' && value.length > 0) return value.split(',')[0].trim();
  return undefined;
}

function isLocalHost(host: string): boolean {
  const hostname = host.split(':')[0].toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export interface AuthorizePageParams {
  clientId: string;
  redirectUri: string;
  resource?: string;
  state?: string;
  scope?: string;
  codeChallenge: string;
  codeChallengeMethod: CodeChallengeMethod;
  responseType: string;
  error?: string;
}

export function renderAuthorizePage(params: AuthorizePageParams): string {
  const hidden = (name: string, value: string | undefined) =>
    value === undefined ? '' : `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;

  const error = params.error
    ? `<p class="error">${escapeHtml(params.error)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>mvmt – authorize connector</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 420px; margin: 4rem auto; padding: 0 1rem; color: #111; }
    h1 { font-size: 1.25rem; }
    p { color: #444; line-height: 1.5; }
    label { display: block; font-size: 0.875rem; margin-top: 1rem; }
    input[type=password] { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; }
    button { margin-top: 1rem; padding: 0.6rem 1rem; font-size: 1rem; background: #111; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
    code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 3px; }
    .error { color: #b00020; }
    .muted { color: #666; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Authorize connector</h1>
  <p>
    A client (<code>${escapeHtml(params.clientId)}</code>) is requesting access to your local mvmt instance.
    Paste your mvmt session token to approve. Run <code>mvmt token</code> on the host machine to retrieve it.
  </p>
  ${error}
  <form method="POST" action="/authorize">
    ${hidden('response_type', params.responseType)}
    ${hidden('client_id', params.clientId)}
    ${hidden('redirect_uri', params.redirectUri)}
    ${hidden('resource', params.resource)}
    ${hidden('state', params.state)}
    ${hidden('scope', params.scope)}
    ${hidden('code_challenge', params.codeChallenge)}
    ${hidden('code_challenge_method', params.codeChallengeMethod)}
    <label for="session_token">mvmt session token</label>
    <input id="session_token" name="session_token" type="password" autocomplete="off" required />
    <button type="submit">Approve</button>
  </form>
  <p class="muted">You will be redirected back to <code>${escapeHtml(new URL(params.redirectUri).host)}</code>.</p>
</body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
