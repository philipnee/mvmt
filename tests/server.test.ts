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
        `http://127.0.0.1:${server.port}/authorize?response_type=code&client_id=test-client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&code_challenge=secret-challenge&code_challenge_method=plain`,
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
      const verifier = 'test-verifier';
      const authorize = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: 'chatgpt',
          redirect_uri: redirectUri,
          resource,
          code_challenge: verifier,
          code_challenge_method: 'plain',
          session_token: sessionToken,
        }),
      });
      expect(authorize.status).toBe(302);
      const location = authorize.headers.get('location');
      expect(location).toBeTruthy();
      const code = new URL(location!).searchParams.get('code');
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
      const body = await token.json();
      expect(body.token_type).toBe('Bearer');
      expect(body.access_token).toBeTypeOf('string');
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
