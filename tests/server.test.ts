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
  MVMT_SERVER_INSTRUCTIONS,
  startHttpServer,
} from '../src/server/index.js';
import { parseConfig } from '../src/config/loader.js';
import { TextContextIndex } from '../src/context/text-index.js';
import { OAuthStore } from '../src/server/oauth.js';
import { ToolRouter } from '../src/server/router.js';
import { hashApiToken } from '../src/utils/api-token-hash.js';
import { ensureSigningKey, generateSessionToken, rotateSigningKey } from '../src/utils/token.js';

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
  it('sends agent instructions during MCP initialization', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'mvmt-instructions-test', version: '0.0.0' },
          },
        }),
      });

      expect(response.status).toBe(200);
      const body = parseMcpResponse(await response.text());
      expect(body.result.instructions).toBe(MVMT_SERVER_INSTRUCTIONS);
      expect(body.result.instructions).toContain('For content questions, call search first');
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('serves OAuth authorization metadata for the root and MCP resource path', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const requestLogs: Array<{ kind: string; status: number; detail?: string; clientId?: string }> = [];
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      requestLog: (entry) => requestLogs.push(entry),
    });

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
        expect(metadata.authorization_response_iss_parameter_supported).toBeUndefined();
        expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
        expect(metadata.scopes_supported).toEqual(['mcp', 'offline_access']);
      }
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('serves protected resource metadata with the scopes ChatGPT requests', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const requestLogs: Array<{ kind: string; status: number; detail?: string; clientId?: string }> = [];
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      requestLog: (entry) => requestLogs.push(entry),
    });

    try {
      for (const pathSuffix of [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp',
      ]) {
        const response = await fetch(`http://127.0.0.1:${server.port}${pathSuffix}`);
        expect(response.status).toBe(200);
        const metadata = await response.json();
        expect(metadata.resource).toBe(`http://127.0.0.1:${server.port}/mcp`);
        expect(metadata.authorization_servers).toEqual([`http://127.0.0.1:${server.port}`]);
        expect(metadata.scopes_supported).toEqual(['mcp', 'offline_access']);
      }
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('emits sanitized request logs for OAuth discovery, registration, and auth failures', async () => {
    const router = new ToolRouter();
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
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const resource = `http://127.0.0.1:${server.port}/mcp`;
      await fetch(`http://127.0.0.1:${server.port}/.well-known/oauth-authorization-server/mcp`);
      await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'test-client',
          redirect_uris: ['https://client.example/callback'],
        }),
      });
      await fetch(
        `http://127.0.0.1:${server.port}/authorize?response_type=code&client_id=test-client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&resource=${encodeURIComponent(resource)}&code_challenge=secret-challenge&code_challenge_method=S256`,
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
            detail: 'missing_bearer',
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

  it('logs invalid bearer tokens distinctly from missing ones', async () => {
    const router = new ToolRouter();
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
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(response.status).toBe(401);
      expect(requestLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'mcp.auth',
            path: '/mcp',
            status: 401,
            detail: 'invalid_bearer',
          }),
        ]),
      );
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('blocks cross-origin browser requests to OAuth endpoints', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const requestLogs: Array<{ kind: string; path: string; status: number; detail?: string }> = [];
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      requestLog: (entry) => requestLogs.push(entry),
    });

    try {
      const origin = 'https://evil.example.com';
      const responses = await Promise.all([
        fetch(`http://127.0.0.1:${server.port}/register`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris: ['https://client.example/callback'] }),
        }),
        fetch(`http://127.0.0.1:${server.port}/authorize`, {
          headers: { Origin: origin },
        }),
        fetch(`http://127.0.0.1:${server.port}/authorize`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({}),
        }),
        fetch(`http://127.0.0.1:${server.port}/token`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code' }),
        }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
      expect(requestLogs.filter((entry) => entry.kind === 'oauth.origin')).toHaveLength(4);
      expect(requestLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '/register', status: 403, detail: 'origin_not_allowed' }),
          expect.objectContaining({ path: '/authorize', status: 403, detail: 'origin_not_allowed' }),
          expect.objectContaining({ path: '/token', status: 403, detail: 'origin_not_allowed' }),
        ]),
      );
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('allows OAuth browser requests from the public tunnel origin', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      resolvePublicBaseUrl: () => 'https://mvmt.example.com',
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { Origin: 'https://mvmt.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://client.example/callback'] }),
      });
      expect(response.status).toBe(201);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exchanges an authorization code when the OAuth resource parameter is echoed', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const resource = `http://127.0.0.1:${server.port}/mcp`;
      const redirectUri = 'https://chatgpt.com/connector/oauth/test-callback';
      const { verifier, challenge } = s256Pair();
      await registerClient(server.port, 'chatgpt', [redirectUri], sessionToken);
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
      expect(redirect.searchParams.get('iss')).toBeNull();

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
      expect(body.refresh_token).toBeTypeOf('string');
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exchanges an authorization code when the token request omits a resource already bound at authorize time', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const resource = `http://127.0.0.1:${server.port}/mcp`;
      const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
      const { verifier, challenge } = s256Pair();
      await registerClient(server.port, 'claude', [redirectUri], sessionToken);
      const authorize = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: 'claude',
          redirect_uri: redirectUri,
          resource,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          session_token: sessionToken,
        }),
      });
      expect(authorize.status).toBe(302);
      const code = new URL(authorize.headers.get('location')!).searchParams.get('code');
      expect(code).toBeTruthy();

      const token = await fetch(`http://127.0.0.1:${server.port}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          client_id: 'claude',
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      });
      expect(token.status).toBe(200);
      const body = await token.json();
      expect(body.token_type).toBe('Bearer');
      expect(body.access_token).toBeTypeOf('string');
      expect(body.refresh_token).toBeTypeOf('string');
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exchanges a refresh token for a new access token', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const resource = `http://127.0.0.1:${server.port}/mcp`;
      const redirectUri = 'https://chatgpt.com/connector/oauth/test-callback';
      const { verifier, challenge } = s256Pair();
      await registerClient(server.port, 'chatgpt', [redirectUri], sessionToken);
      const authorize = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: 'chatgpt',
          redirect_uri: redirectUri,
          resource,
          scope: 'mcp offline_access',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          session_token: sessionToken,
        }),
      });
      const code = new URL(authorize.headers.get('location')!).searchParams.get('code');
      expect(code).toBeTruthy();

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
      const firstGrant = await token.json();
      expect(firstGrant.refresh_token).toBeTypeOf('string');

      const refresh = await fetch(`http://127.0.0.1:${server.port}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'chatgpt',
          refresh_token: firstGrant.refresh_token,
        }),
      });
      expect(refresh.status).toBe(200);
      const refreshedGrant = await refresh.json();
      expect(refreshedGrant.access_token).toBeTypeOf('string');
      expect(refreshedGrant.refresh_token).toBeTypeOf('string');
      expect(refreshedGrant.access_token).not.toBe(firstGrant.access_token);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('omits the optional issuer parameter from the authorization redirect', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const resource = `http://127.0.0.1:${server.port}/mcp`;
      const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
      const { challenge } = s256Pair();
      await registerClient(server.port, 'claude', [redirectUri], sessionToken);
      const authorize = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: 'claude',
          redirect_uri: redirectUri,
          resource,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: 'test-state',
          session_token: sessionToken,
        }),
      });
      expect(authorize.status).toBe(302);
      const redirect = new URL(authorize.headers.get('location')!);
      expect(redirect.searchParams.get('code')).toBeTruthy();
      expect(redirect.searchParams.get('state')).toBe('test-state');
      expect(redirect.searchParams.has('iss')).toBe(false);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects /authorize for unregistered redirect_uri', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const { challenge } = s256Pair();
      await registerClient(server.port, 'claude', ['https://claude.ai/registered/cb'], sessionToken);

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

  it('defaults a missing GET /authorize resource to the canonical MCP resource', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const signingKeyPath = path.join(tmp, '.mvmt', '.signing-key');
    const requestLogs: Array<{ kind: string; status: number; detail?: string; clientId?: string }> = [];
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      signingKeyPath,
      requestLog: (entry) => requestLogs.push(entry),
    });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
      const { verifier, challenge } = s256Pair();
      const resource = `http://127.0.0.1:${server.port}/mcp`;
      await registerClient(server.port, 'claude', [redirectUri], sessionToken);

      const promptUrl = new URL(`http://127.0.0.1:${server.port}/authorize`);
      promptUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: 'claude',
        redirect_uri: redirectUri,
        state: 'resource-state',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      const prompt = await fetch(promptUrl);
      expect(prompt.status).toBe(200);
      const promptBody = await prompt.text();
      expect(promptBody).toContain(`name="resource" value="${resource}"`);

      const approve = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: 'claude',
          redirect_uri: redirectUri,
          resource,
          state: 'resource-state',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          session_token: sessionToken,
        }),
      });
      expect(approve.status).toBe(302);
      const approveRedirect = new URL(approve.headers.get('location')!);
      const code = approveRedirect.searchParams.get('code');
      expect(code).toBeTruthy();

      const accessToken = await exchangeAuthorizationCodeForToken({
        port: server.port,
        clientId: 'claude',
        redirectUri,
        code: code!,
        verifier,
      });
      expectAccessTokenAudience(accessToken, signingKeyPath, resource);
      expect(requestLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'oauth.authorize',
            status: 200,
            detail: expect.stringContaining('resource_defaulted=true'),
          }),
        ]),
      );
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('defaults a missing POST /authorize resource to the canonical MCP resource', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const signingKeyPath = path.join(tmp, '.mvmt', '.signing-key');
    const requestLogs: Array<{ kind: string; status: number; detail?: string; clientId?: string }> = [];
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      signingKeyPath,
      requestLog: (entry) => requestLogs.push(entry),
    });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
      const { verifier, challenge } = s256Pair();
      const resource = `http://127.0.0.1:${server.port}/mcp`;
      await registerClient(server.port, 'claude', [redirectUri], sessionToken);

      const authorize = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: 'claude',
          redirect_uri: redirectUri,
          state: 'resource-state',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          session_token: sessionToken,
        }),
      });
      expect(authorize.status).toBe(302);
      const authorizeRedirect = new URL(authorize.headers.get('location')!);
      const code = authorizeRedirect.searchParams.get('code');
      expect(code).toBeTruthy();

      const accessToken = await exchangeAuthorizationCodeForToken({
        port: server.port,
        clientId: 'claude',
        redirectUri,
        code: code!,
        verifier,
      });
      expectAccessTokenAudience(accessToken, signingKeyPath, resource);
      expect(requestLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'oauth.authorize',
            status: 302,
            detail: expect.stringContaining('resource_defaulted=true'),
          }),
        ]),
      );
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('redirects explicit /authorize resource mismatches to the registered redirect_uri', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const requestLogs: Array<{ kind: string; status: number; detail?: string; clientId?: string }> = [];
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      requestLog: (entry) => requestLogs.push(entry),
    });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
      const { challenge } = s256Pair();
      await registerClient(server.port, 'claude', [redirectUri], sessionToken);

      const wrongUrl = new URL(`http://127.0.0.1:${server.port}/authorize`);
      wrongUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: 'claude',
        redirect_uri: redirectUri,
        resource: 'https://other.example.com/mcp',
        state: 'get-state',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      const wrong = await fetch(wrongUrl, { redirect: 'manual' });
      expect(wrong.status).toBe(302);
      const wrongRedirect = new URL(wrong.headers.get('location')!);
      expect(`${wrongRedirect.origin}${wrongRedirect.pathname}`).toBe(redirectUri);
      expect(wrongRedirect.searchParams.get('error')).toBe('invalid_target');
      expect(wrongRedirect.searchParams.get('error_description')).toBe('Invalid resource');
      expect(wrongRedirect.searchParams.get('state')).toBe('get-state');
      expect(requestLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'oauth.authorize', status: 302, detail: 'invalid_resource' }),
        ]),
      );
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts resource URLs with normalized host casing and trailing slash', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      resolvePublicBaseUrl: () => 'https://mvmt.example.com',
    });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
      const { challenge } = s256Pair();
      await registerClient(server.port, 'claude', [redirectUri], sessionToken);

      const authorize = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: 'claude',
          redirect_uri: redirectUri,
          resource: 'https://MVMT.EXAMPLE.COM/mcp/',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          session_token: sessionToken,
        }),
      });

      expect(authorize.status).toBe(302);
      const redirect = new URL(authorize.headers.get('location')!);
      expect(redirect.searchParams.get('code')).toEqual(expect.any(String));
      expect(redirect.searchParams.has('error')).toBe(false);

      for (const resource of ['https://user@mvmt.example.com/mcp', 'https://mvmt.example.com/mcp#fragment']) {
        const rejected = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            response_type: 'code',
            client_id: 'claude',
            redirect_uri: redirectUri,
            resource,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            session_token: sessionToken,
          }),
        });
        expect(rejected.status).toBe(302);
        const rejectedRedirect = new URL(rejected.headers.get('location')!);
        expect(rejectedRedirect.searchParams.get('error')).toBe('invalid_target');
        expect(rejectedRedirect.searchParams.get('error_description')).toBe('Invalid resource');
      }
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects /register when redirect_uris are missing', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'no uris' }),
      });
      expect(response.status).toBe(400);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('guards caller-supplied OAuth client_id registration', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const named = await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'chatgpt',
          redirect_uris: ['https://chatgpt.com/connector/oauth/test-callback'],
        }),
      });
      expect(named.status).toBe(401);

      const generated = await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://chatgpt.com/connector/oauth/test-callback'],
        }),
      });
      expect(generated.status).toBe(201);
      const generatedBody = await generated.json();
      expect(generatedBody.client_id).toEqual(expect.stringMatching(/^mvmt-[0-9a-f-]{36}$/));

      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      await registerClient(server.port, 'chatgpt', ['https://chatgpt.com/connector/oauth/test-callback'], sessionToken);

      const duplicate = await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'chatgpt',
          redirect_uris: ['https://attacker.example/callback'],
        }),
      });
      expect(duplicate.status).toBe(409);
      const duplicateBody = await duplicate.json();
      expect(duplicateBody.error).toBe('invalid_client_metadata');
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('limits OAuth dynamic client registration fan-out', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: Array.from({ length: 11 }, (_, index) => `https://client.example/cb/${index}`),
        }),
      });
      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error).toBe('invalid_client_metadata');
      expect(body.error_description).toContain('redirect_uris exceeds');
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns 500 from /register when the client registry cannot be persisted', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      fs.chmodSync(path.dirname(tokenPath), 0o500);
      const response = await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
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

  it('returns an RFC 7591-style client information response from /register', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const response = await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'chatgpt',
          client_name: 'ChatGPT Connector',
          scope: 'mcp',
          redirect_uris: ['https://chatgpt.com/connector/oauth/test-callback'],
        }),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toMatchObject({
        client_id: 'chatgpt',
        client_name: 'ChatGPT Connector',
        scope: 'mcp',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        redirect_uris: ['https://chatgpt.com/connector/oauth/test-callback'],
      });
      expect(body.client_id_issued_at).toEqual(expect.any(Number));
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('uses resolvePublicBaseUrl and ignores X-Forwarded-Host in OAuth metadata', async () => {
    const router = new ToolRouter();
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
    const router = new ToolRouter();
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
    const router = new ToolRouter();
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

  it('keeps OAuth access tokens valid across restarts when the advertised resource is unchanged', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const resourceBaseUrl = 'https://mvmt.example.com';
    const firstServer = await startHttpServer(router, {
      port: 0,
      tokenPath,
      resolvePublicBaseUrl: () => resourceBaseUrl,
    });
    const port = firstServer.port;

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const accessToken = await exchangeAccessToken(port, sessionToken, resourceBaseUrl);

      const beforeRestart = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(beforeRestart.status).toBe(200);

      await firstServer.close();

      const secondServer = await startHttpServer(router, {
        port: 0,
        tokenPath,
        resolvePublicBaseUrl: () => resourceBaseUrl,
      });
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

  it('recovers stale MCP session IDs after a server restart', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const firstServer = await startHttpServer(router, { port: 0, tokenPath });
    const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();

    try {
      const initialize = await fetch(`http://127.0.0.1:${firstServer.port}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'mvmt-test', version: '0.0.0' },
          },
        }),
      });
      expect(initialize.status).toBe(200);
      const staleSessionId = initialize.headers.get('mcp-session-id');
      expect(staleSessionId).toBeTruthy();
      await initialize.text();

      await firstServer.close();

      const secondServer = await startHttpServer(router, { port: 0, tokenPath });
      try {
        const listTools = await fetch(`http://127.0.0.1:${secondServer.port}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${sessionToken}`,
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'Mcp-Protocol-Version': '2025-03-26',
            'Mcp-Session-Id': staleSessionId!,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        });

        expect(listTools.status).toBe(200);
        await expect(listTools.text()).resolves.toContain('"tools"');
      } finally {
        await secondServer.close();
      }
    } finally {
      await firstServer.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects OAuth access tokens when the advertised resource changes across restart', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const firstServer = await startHttpServer(router, {
      port: 0,
      tokenPath,
      resolvePublicBaseUrl: () => 'https://mvmt.example.com',
    });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const accessToken = await exchangeAccessToken(firstServer.port, sessionToken, 'https://mvmt.example.com');

      await firstServer.close();

      const secondServer = await startHttpServer(router, {
        port: 0,
        tokenPath,
        resolvePublicBaseUrl: () => 'https://other.example.com',
      });
      try {
        const afterRestart = await fetch(`http://127.0.0.1:${secondServer.port}/health`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        expect(afterRestart.status).toBe(401);
      } finally {
        await secondServer.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts legacy audience-less OAuth access tokens during the compatibility window', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const signingKeyPath = path.join(tmp, '.mvmt', '.signing-key');
    const signingKey = ensureSigningKey(signingKeyPath);
    const legacyStore = new OAuthStore({ signingKey });
    const legacyToken = legacyStore.issueAccessToken({ clientId: 'claude' }).token;
    const server = await startHttpServer(router, { port: 0, tokenPath, signingKeyPath });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: `Bearer ${legacyToken}` },
      });
      expect(response.status).toBe(200);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects unknown OAuth clients with a quarantine error once clients[] is configured', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const signingKeyPath = path.join(tmp, '.mvmt', '.signing-key');
    const requestLogs: Array<{ kind: string; status: number; detail?: string; clientId?: string }> = [];
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      signingKeyPath,
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          auth: { type: 'token', tokenHash: hashApiToken('codex-local-token') },
          rawToolsEnabled: true,
          permissions: [],
        },
      ],
      requestLog: (entry) => requestLogs.push(entry),
    });

    try {
      const oauthStore = new OAuthStore({ signingKey: ensureSigningKey(signingKeyPath) });
      const accessToken = oauthStore.issueAccessToken({
        clientId: 'unknown-dcr-client',
        audience: `http://127.0.0.1:${server.port}/mcp`,
      }).token;
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'oauth_client_quarantined',
        error_description: 'OAuth client_id is not mapped to a configured mvmt client; admin must approve',
      });
      expect(requestLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'health.auth',
            status: 403,
            clientId: 'quarantine:unknown-dcr-client',
            detail: 'quarantined oauth_client_id=unknown-dcr-client',
          }),
        ]),
      );
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('authorizes OAuth sessions with a scoped API token selected by the user', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const signingKeyPath = path.join(tmp, '.mvmt', '.signing-key');
    const requestLogs: Array<{ kind: string; status: number; detail?: string; clientId?: string }> = [];
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      signingKeyPath,
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          auth: { type: 'token', tokenHash: hashApiToken('codex-api-token') },
          rawToolsEnabled: false,
          permissions: [{ path: '/workspace/**', actions: ['search', 'read'] }],
        },
      ],
      requestLog: (entry) => requestLogs.push(entry),
    });

    try {
      const redirectUri = 'https://codex.example/callback';
      const registration = await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      });
      expect(registration.status).toBe(201);
      const { client_id: oauthClientId } = await registration.json() as { client_id: string };
      const { verifier, challenge } = s256Pair();
      const resource = `http://127.0.0.1:${server.port}/mcp`;

      const authorize = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: oauthClientId,
          redirect_uri: redirectUri,
          resource,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          api_token: 'codex-api-token',
        }),
      });
      expect(authorize.status).toBe(302);
      const code = new URL(authorize.headers.get('location')!).searchParams.get('code');
      expect(code).toBeTruthy();

      const token = await fetch(`http://127.0.0.1:${server.port}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          client_id: oauthClientId,
          redirect_uri: redirectUri,
          resource,
          code_verifier: verifier,
        }),
      });
      expect(token.status).toBe(200);
      const grant = await token.json() as { access_token: string };

      const health = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: `Bearer ${grant.access_token}` },
      });
      expect(health.status).toBe(200);
      expect(requestLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'oauth.authorize',
            status: 302,
            clientId: oauthClientId,
            detail: expect.stringContaining('authorized_client=codex'),
          }),
          expect.objectContaining({
            kind: 'health.request',
            status: 200,
          }),
        ]),
      );
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects OAuth approval with an invalid scoped API token', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          auth: { type: 'token', tokenHash: hashApiToken('codex-api-token') },
          rawToolsEnabled: false,
          permissions: [{ path: '/workspace/**', actions: ['search', 'read'] }],
        },
      ],
    });

    try {
      const redirectUri = 'https://codex.example/callback';
      const registration = await fetch(`http://127.0.0.1:${server.port}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      });
      const { client_id: oauthClientId } = await registration.json() as { client_id: string };
      const { challenge } = s256Pair();
      const authorize = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: oauthClientId,
          redirect_uri: redirectUri,
          resource: `http://127.0.0.1:${server.port}/mcp`,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          api_token: 'wrong-token',
        }),
      });

      expect(authorize.status).toBe(401);
      const body = await authorize.text();
      expect(body).toContain('Invalid API token. Try again.');
      expect(body).not.toContain('name="code"');
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects the session token on /mcp once clients[] is configured', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          auth: { type: 'token', tokenHash: hashApiToken('codex-local-token') },
          rawToolsEnabled: true,
          permissions: [],
        },
      ],
    });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      expect(response.status).toBe(401);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('preserves legacy session-token access when clients[] is absent', async () => {
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      expect(response.status).toBe(200);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('filters MCP tools/list and denies tool calls by resolved client permissions', async () => {
    const { index, tmp: indexTmp } = await createTextIndexServerFixture();
    const router = new ToolRouter(undefined, [], { contextIndex: index });
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      clients: [
        {
          id: 'searcher',
          name: 'Search-only client',
          auth: { type: 'token', tokenHash: hashApiToken('search-token') },
          rawToolsEnabled: true,
          permissions: [{ path: '/workspace/**', actions: ['search'] }],
        },
      ],
    });

    try {
      const sessionId = await initializeMcpSession(server.port, 'search-token');
      const listTools = await mcpJsonRequest(server.port, 'search-token', sessionId, 2, 'tools/list', {});
      expect(listTools.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'search',
      ]);

      const denied = await mcpJsonRequest(server.port, 'search-token', sessionId, 3, 'tools/call', {
        name: 'read',
        arguments: { path: '/workspace/note.md' },
      });
      expect(denied.result.isError).toBe(true);
      expect(denied.result.content[0].text).toContain('missing_permission path=/workspace/note.md action=read');
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(indexTmp, { recursive: true, force: true });
    }
  });

  it('serves mount tools over MCP for clients without raw tool access', async () => {
    const { index, tmp: indexTmp } = await createTextIndexServerFixture({
      mountName: 'notes',
      mountPath: '/notes',
      files: { 'projects/launch.md': '# Launch\nShip it.' },
    });
    const router = new ToolRouter(undefined, [], { contextIndex: index });
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const server = await startHttpServer(router, {
      port: 0,
      tokenPath,
      clients: [
        {
          id: 'chatgpt',
          name: 'ChatGPT',
          auth: { type: 'token', tokenHash: hashApiToken('chatgpt-token') },
          rawToolsEnabled: false,
          permissions: [{ path: '/notes/**', actions: ['search', 'read'] }],
        },
      ],
    });

    try {
      const sessionId = await initializeMcpSession(server.port, 'chatgpt-token');
      const listTools = await mcpJsonRequest(server.port, 'chatgpt-token', sessionId, 2, 'tools/list', {});
      expect(listTools.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'search',
        'list',
        'read',
      ]);

      const search = await mcpJsonRequest(server.port, 'chatgpt-token', sessionId, 3, 'tools/call', {
        name: 'search',
        arguments: { query: 'launch' },
      });
      expect(JSON.parse(search.result.content[0].text).results).toEqual([
        expect.objectContaining({ mount: 'notes', path: '/notes/projects/launch.md' }),
      ]);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(indexTmp, { recursive: true, force: true });
    }
  });

  it('revokes outstanding OAuth access tokens the moment the signing key file is rewritten', async () => {
    const router = new ToolRouter();
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

      // Simulate internal session-token rotation writing a new signing key. The
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
    const router = new ToolRouter();
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
          body: JSON.stringify({ redirect_uris: ['https://rl.example/cb'] }),
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
    const router = new ToolRouter();
    await router.initialize();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-test-'));
    const tokenPath = path.join(tmp, '.mvmt', '.session-token');
    const firstServer = await startHttpServer(router, { port: 0, tokenPath });

    try {
      const sessionToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      const registration = await fetch(`http://127.0.0.1:${firstServer.port}/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
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
      const resource = `http://127.0.0.1:${secondServer.port}/mcp`;
      const { challenge } = s256Pair();
      const authorize = await fetch(`http://127.0.0.1:${secondServer.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: 'persisted-client',
          redirect_uri: 'https://persisted.example/cb',
          resource,
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

interface TextIndexServerFixtureOptions {
  mountName?: string;
  mountPath?: string;
  files?: Record<string, string>;
}

async function createTextIndexServerFixture(
  options: TextIndexServerFixtureOptions = {},
): Promise<{ index: TextContextIndex; tmp: string }> {
  const mountName = options.mountName ?? 'workspace';
  const mountPath = options.mountPath ?? '/workspace';
  const files = options.files ?? { 'note.md': 'alpha note' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-server-index-'));
  const root = path.join(tmp, 'root');
  fs.mkdirSync(root);

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf-8');
  }

  const config = parseConfig({
    version: 1,
    mounts: [{ name: mountName, type: 'local_folder', path: mountPath, root, writeAccess: true }],
  });
  const index = new TextContextIndex({
    mounts: config.mounts,
    indexPath: path.join(tmp, 'index.json'),
  });
  await index.rebuild();
  return { index, tmp };
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

async function registerClient(port: number, clientId: string, redirectUris: string[], sessionToken: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, redirect_uris: redirectUris }),
  });
  expect(response.status).toBe(201);
}

async function exchangeAccessToken(port: number, sessionToken: string, resourceBaseUrl?: string): Promise<string> {
  const redirectUri = 'https://codex.example/callback';
  const { verifier, challenge } = s256Pair();
  const resource = `${resourceBaseUrl ?? `http://127.0.0.1:${port}`}/mcp`;
  await registerClient(port, 'codex', [redirectUri], sessionToken);
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

async function exchangeAuthorizationCodeForToken(input: {
  port: number;
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
  resource?: string;
}): Promise<string> {
  const token = await fetch(`http://127.0.0.1:${input.port}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      ...(input.resource ? { resource: input.resource } : {}),
      code_verifier: input.verifier,
    }),
  });
  const body = await token.json();
  expect(token.status).toBe(200);
  expect(body.access_token).toBeTypeOf('string');
  return body.access_token as string;
}

function expectAccessTokenAudience(accessToken: string, signingKeyPath: string, expectedAudience: string): void {
  const validator = new OAuthStore({ signingKey: ensureSigningKey(signingKeyPath) });
  const validated = validator.validateAccessToken(`Bearer ${accessToken}`, {
    expectedAudience,
    allowLegacyNoAudience: false,
  });
  expect(validated?.audience).toBe(expectedAudience);
}

async function initializeMcpSession(port: number, token: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'mvmt-policy-test', version: '0.0.0' },
      },
    }),
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  await response.text();
  return sessionId!;
}

async function mcpJsonRequest(
  port: number,
  token: string,
  sessionId: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Protocol-Version': '2025-03-26',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(response.status).toBe(200);
  return parseMcpResponse(await response.text());
}

function parseMcpResponse(text: string): any {
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`Could not parse MCP response: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length));
}
