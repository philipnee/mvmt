import fs from 'node:fs';
import { createServer } from 'node:net';
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
import { TOKEN_PATH } from '../src/utils/token.js';

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
  it('returns a close handle that releases the listening port', async () => {
    const router = new ToolRouter([new EmptyConnector()]);
    await router.initialize();
    const server = await startHttpServer(router, { port: 0 });

    try {
      const token = fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
    } finally {
      await server.close();
    }

    await expect(canListenOn(server.port)).resolves.toBe(true);
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
