import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { buildOriginCheck } from '../src/server/index.js';

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
