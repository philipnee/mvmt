import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import {
  buildOriginCheck,
  isBenignDuplicateSseConflict,
  isStandaloneSseRequest,
  startHttpServer,
} from '../src/server/index.js';
import { ToolRouter } from '../src/server/router.js';
import { Connector } from '../src/connectors/types.js';
import { generateSessionToken, rotateSigningKey } from '../src/utils/token.js';

function req(origin?: string): Request {
  return { headers: origin === undefined ? {} : { origin } } as unknown as Request;
}

describe('buildOriginCheck', () => {
  const check = buildOriginCheck([]);

  it('allows requests with no Origin (non-browser MCP clients)', () => {
    expect(check(req())).toBe(true);
  });

  it('allows localhost and 127.0.0.1 origins on any port', () => {
    expect(check(req('http://localhost'))).toBe(true);
    expect(check(req('http://localhost:4141'))).toBe(true);
    expect(check(req('http://127.0.0.1:4141'))).toBe(true);
    expect(check(req('http://[::1]:4141'))).toBe(true);
  });

  it('rejects arbitrary remote origins (DNS rebinding)', () => {
    expect(check(req('http://evil.example.com'))).toBe(false);
    expect(check(req('https://claude.ai'))).toBe(false);
  });

  it('allows explicitly configured extra origins', () => {
    const withClaude = buildOriginCheck(['https://claude.ai']);
    expect(withClaude(req('https://claude.ai'))).toBe(true);
    expect(withClaude(req('https://Claude.AI'))).toBe(true);
    expect(withClaude(req('https://evil.example.com'))).toBe(false);
  });

  it('rejects malformed Origin headers', () => {
    expect(check(req('not a url'))).toBe(false);
  });
});

describe('SSE request helpers', () => {
  it('identifies standalone SSE GET requests', () => {
    expect(
      isStandaloneSseRequest({
        method: 'GET',
        headers: { accept: 'application/json, text/event-stream' },
      } as unknown as Request),
    ).toBe(true);
  });

  it('does not classify non-SSE GET requests as standalone SSE requests', () => {
    expect(
      isStandaloneSseRequest({
        method: 'GET',
        headers: { accept: 'application/json' },
      } as unknown as Request),
    ).toBe(false);
  });

  it('treats duplicate standalone SSE conflicts as benign reconnect noise', () => {
    expect(isBenignDuplicateSseConflict(new Error('Conflict: Only one SSE stream is allowed per session'))).toBe(true);
    expect(isBenignDuplicateSseConflict(new Error('Conflict: Stream already has an active connection'))).toBe(false);
  });
});

describe('startHttpServer lifecycle', () => {
  it('serves OAuth authorization metadata for the root and MCP resource path', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      for (const pathSuffix of [
        '/.well-known/oauth-authorization-server',
        '/.well-known/oauth-authorization-server/mcp',
      ]) {
        const response = await fetch(`http://127.0.0.1:${server.port}${pathSuffix}`);
        expect(response.status).toBe(200);
        const metadata = await response.json();
        expect(metadata.registration_endpoint).toBe(`http://127.0.0.1:${server.port}/register`);
        expect(metadata.authorization_endpoint).toBe(`http://127.0.0.1:${server.port}/authorize`);
        expect(metadata.token_endpoint).toBe(`http://127.0.0.1:${server.port}/token`);
        expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
      }
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('emits sanitized request logs for OAuth discovery, registration, and auth failures', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const requestLogs: Array<{ kind: string; path: string; status: number; detail?: string; clientId?: string }> = [];
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      requestLog: (entry) => requestLogs.push(entry),
    });

    try {
      await fetch(`http://127.0.0.1:${server.port}/.well-known/oauth-authorization-server/mcp`);
      await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'test-client',
          redirect_uris: ['https://client.example/callback'],
        }),
      });
      await fetch(
        `http://127.0.0.1:${server.port}/authorize?response_type=code&client_id=test-client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&code_challenge=secret-challenge&code_challenge_method=S256`,
      );
      await fetch(`http://127.0.0.1:${server.port}/mcp`);

      expect(requestLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'oauth.discovery',
            path: '/.well-known/oauth-authorization-server/mcp',
            status: 200,
          }),
          expect.objectContaining({
            kind: 'oauth.register',
            path: '/register',
            status: 201,
            clientId: 'test-client',
          }),
          expect.objectContaining({
            kind: 'oauth.authorize',
            path: '/authorize',
            status: 200,
            clientId: 'test-client',
          }),
          expect.objectContaining({
            kind: 'mcp.auth',
            path: '/mcp',
            status: 401,
            detail: 'missing_or_invalid_bearer',
          }),
        ]),
      );
      expect(JSON.stringify(requestLogs)).not.toContain('secret-challenge');
      expect(JSON.stringify(requestLogs)).not.toContain('client.example/callback');
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exchanges an authorization code when the OAuth resource parameter is echoed', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const resource = `http://127.0.0.1:${server.port}/mcp`;
      const redirectUri = 'https://chatgpt.com/connector/oauth/test-callback';
      const { verifier, challenge } = s256Pair();
      await registerClient(server.port, 'chatgpt', [redirectUri]);
      const authorize = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: 'chatgpt',
          redirect_uri: redirectUri,
          resource,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          session_token: sessionToken,
        }),
      });
      expect(authorize.status).toBe(302);
      const location = authorize.headers.get('location');
      expect(location).toBeTruthy();
      const redirect = new URL(location!);
      const code = redirect.searchParams.get('code');
      expect(code).toBeTruthy();
      expect(redirect.searchParams.get('iss')).toBe(`http://127.0.0.1:${server.port}`);

      const token = await fetch(`http://127.0.0.1:${server.port}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          client_id: 'chatgpt',
          redirect_uri: redirectUri,
          resource,
          code_verifier: verifier,
        }),
      });
      expect(token.status).toBe(200);
      const body = await token.json();
      expect(body.token_type).toBe('Bearer');
      expect(body.access_token).toBeTypeOf('string');
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects /authorize for unregistered redirect_uri', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const { challenge } = s256Pair();
      await registerClient(server.port, 'claude', ['https://claude.ai/registered/cb']);

      const response = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: 'claude',
          redirect_uri: 'https://attacker.example/cb',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          session_token: sessionToken,
        }),
      });
      expect(response.status).toBe(400);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects /register when redirect_uris are missing', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: 'no-uris' }),
      });
      expect(response.status).toBe(400);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns 500 from /register when the client registry cannot be persisted', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      fs.chmodSync(path.dirname(tokenPath), 0o500);
      const response = await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'persist-fail-client',
          redirect_uris: ['https://persist-fail.example/cb'],
        }),
      });
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('server_error');
    } finally {
      fs.chmodSync(path.dirname(tokenPath), 0o700);
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('uses resolvePublicBaseUrl and ignores X-Forwarded-Host in OAuth metadata', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      resolvePublicBaseUrl: () => 'https://mvmt.example.com',
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/.well-known/oauth-authorization-server`, {
        headers: { 'X-Forwarded-Host': 'attacker.example.com', 'X-Forwarded-Proto': 'https' },
      });
      const metadata = await response.json();
      expect(metadata.issuer).toBe('https://mvmt.example.com');
      expect(metadata.authorization_endpoint).toBe('https://mvmt.example.com/authorize');
      expect(JSON.stringify(metadata)).not.toContain('attacker');
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns a close handle that releases the listening port', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });
    const port = server.port;

    try {
      const token = fs.readFileSync(tokenPath, 'utf-8').trim();
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    await expect(canListenOn(port)).resolves.toBe(true);
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('reuses an existing session token across server restarts', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const originalToken = generateSessionToken(tokenPath);
    const originalStat = fs.statSync(tokenPath);
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const tokenAfterStart = fs.readFileSync(tokenPath, 'utf-8').trim();
      const statAfterStart = fs.statSync(tokenPath);
      expect(tokenAfterStart).toBe(originalToken);
      expect(statAfterStart.mtimeMs).toBe(originalStat.mtimeMs);

      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: `Bearer ${originalToken}` },
      });
      expect(response.status).toBe(200);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps OAuth access tokens valid across server restarts when the session token is unchanged', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const firstServer = await startHttpServer(router, { port: 0, tokenPath });
    const port = firstServer.port;

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const accessToken = await exchangeAccessToken(port, sessionToken);

      const beforeRestart = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(beforeRestart.status).toBe(200);

      await firstServer.close();

      const secondServer = await startHttpServer(router, { port: 0, tokenPath });
      try {
        const afterRestart = await fetch(`http://127.0.0.1:${secondServer.port}/health`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        expect(afterRestart.status).toBe(200);
      } finally {
        await secondServer.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('revokes outstanding OAuth access tokens the moment the signing key file is rewritten', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const signingKeyPath = path.join(tmp, '.mvmt', '.signing-key');
    const server = await startHttpServer(router, { port: 0, tokenPath, signingKeyPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const accessToken = await exchangeAccessToken(server.port, sessionToken);

      const beforeRotate = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(beforeRotate.status).toBe(200);

      // Simulate `mvmt token rotate` writing a new signing key. The
      // running server must pick it up without restart.
      rotateSigningKey(signingKeyPath);

      const afterRotate = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(afterRotate.status).toBe(401);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rate-limits auth-surface routes and returns 429 once the bucket is exhausted', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      rateLimits: { auth: { windowMs: 60_000, max: 2 } },
    });

    try {
      const hit = () =>
        fetch(`http://127.0.0.1:${server.port}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: 'rl-client', redirect_uris: ['https://rl.example/cb'] }),
        });

      const first = await hit();
      const second = await hit();
      const third = await hit();

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(third.status).toBe(429);
      expect(third.headers.get('retry-after')).toBeTruthy();
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('persists OAuth client registrations across server restarts', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const firstServer = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const registration = await fetch(`http://127.0.0.1:${firstServer.port}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'persisted-client',
          redirect_uris: ['https://persisted.example/cb'],
        }),
      });
      expect(registration.status).toBe(201);
    } finally {
      await firstServer.close();
    }

    const secondServer = await startHttpServer(router, { port: 0, tokenPath });
    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const { challenge } = s256Pair();
      const authorize = await fetch(`http://127.0.0.1:${secondServer.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: 'persisted-client',
          redirect_uri: 'https://persisted.example/cb',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          session_token: sessionToken,
        }),
      });
      // A 302 proves the server trusted the registered redirect_uri
      // even though /register was never called on this fresh instance.
      expect(authorize.status).toBe(302);
    } finally {
      await secondServer.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

class EmptyConnector implements Connector {
  readonly id = 'empty';
  readonly displayName = 'empty';

  async initialize(): Promise<void> {}

  async listTools() {
    return [];
  }

  async callTool() {
    return { content: [{ type: 'text' as const, text: 'ok' }] };
  }

  async shutdown(): Promise<void> {}
}

function canListenOn(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function s256Pair(): { verifier: string; challenge: string } {
  const verifier = 'test-verifier-' + Math.random().toString(36).slice(2);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(port: number, clientId: string, redirectUris: string[]): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, redirect_uris: redirectUris }),
  });
  expect(response.status).toBe(201);
}

async function exchangeAccessToken(port: number, sessionToken: string): Promise<string> {
  const redirectUri = 'https://codex.example/callback';
  const { verifier, challenge } = s256Pair();
  const resource = `http://127.0.0.1:${port}/mcp`;
  await registerClient(port, 'codex', [redirectUri]);
  const authorize = await fetch(`http://127.0.0.1:${port}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: 'codex',
      redirect_uri: redirectUri,
      resource,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      session_token: sessionToken,
    }),
  });
  const location = authorize.headers.get('location');
  const code = location ? new URL(location).searchParams.get('code') : undefined;
  expect(authorize.status).toBe(302);
  expect(code).toBeTruthy();

  const token = await fetch(`http://127.0.0.1:${port}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      client_id: 'codex',
      redirect_uri: redirectUri,
      resource,
      code_verifier: verifier,
    }),
  });
  const body = await token.json();
  expect(token.status).toBe(200);
  expect(body.access_token).toBeTypeOf('string');
  return body.access_token as string;
}
