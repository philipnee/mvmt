import { describe, expect, it } from 'vitest';
import {
  addApiTokenToConfig,
  editApiTokenInConfig,
  removeApiTokenFromConfig,
  rotateApiTokenInConfig,
} from '../src/cli/api-tokens.js';
import { parseConfig } from '../src/config/loader.js';
import { verifyApiToken } from '../src/utils/api-token-hash.js';

const EXISTING_TOKEN_VERIFIER = 'scrypt:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('API token config helpers', () => {
  it('creates a token client with search/read permission for one mount', () => {
    const config = parseConfig({
      version: 1,
      mounts: [
        { name: 'document', type: 'local_folder', path: '/document', root: '/tmp/document' },
      ],
    });

    const result = addApiTokenToConfig(config, {
      id: 'codex',
      name: 'Codex CLI',
      description: 'Used by Codex for the mvmt repo',
      expires: '7d',
      now: Date.parse('2026-04-29T12:00:00.000Z'),
      plaintextToken: 'plain-token',
      clientBinding: 'codex',
      permissions: [{ source: '/document', mode: 'read' }],
    });

    expect(result.created).toBe(true);
    expect(result.plaintextToken).toBe('plain-token');
    expect(result.client).toMatchObject({
      id: 'codex',
      name: 'Codex CLI',
      description: 'Used by Codex for the mvmt repo',
      createdAt: '2026-04-29T12:00:00.000Z',
      credentialVersion: 1,
      expiresAt: '2026-05-06T12:00:00.000Z',
      clientBinding: 'codex',
      auth: { type: 'token' },
      rawToolsEnabled: false,
      permissions: [{ path: '/document/**', actions: ['search', 'read'] }],
    });
    expect(result.client.auth.type).toBe('token');
    if (result.client.auth.type === 'token') {
      expect(result.client.auth.tokenHash).toMatch(/^scrypt:v1:/);
      expect(verifyApiToken('plain-token', result.client.auth.tokenHash)).toBe(true);
    }
  });

  it('edits an existing token permission without rotating its secret', () => {
    const config = parseConfig({
      version: 1,
      mounts: [
        { name: 'workspace', type: 'local_folder', path: '/workspace', root: '/tmp/workspace', writeAccess: true },
      ],
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          auth: { type: 'token', tokenHash: EXISTING_TOKEN_VERIFIER },
          permissions: [{ path: '/workspace/**', actions: ['search', 'read'] }],
        },
      ],
    });

    const result = editApiTokenInConfig(config, 'codex', {
      id: 'codex',
      permissions: [{ source: 'workspace', mode: 'write' }],
    });

    expect(result.created).toBe(false);
    expect(result.plaintextToken).toBeUndefined();
    expect(result.client.auth).toEqual({ type: 'token', tokenHash: EXISTING_TOKEN_VERIFIER });
    expect(result.client.permissions).toEqual([
      { path: '/workspace/**', actions: ['search', 'read', 'write'] },
    ]);
  });

  it('rejects creating over an existing named token', () => {
    const config = parseConfig({
      version: 1,
      mounts: [
        { name: 'workspace', type: 'local_folder', path: '/workspace', root: '/tmp/workspace' },
      ],
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          auth: { type: 'token', tokenHash: EXISTING_TOKEN_VERIFIER },
          permissions: [{ path: '/workspace/**', actions: ['search', 'read'] }],
        },
      ],
    });

    expect(() => addApiTokenToConfig(config, {
      id: 'codex',
      permissions: [{ source: 'workspace', mode: 'read' }],
    })).toThrow('already exists');
  });

  it('creates all-access scopes with the global permission path', () => {
    const config = parseConfig({
      version: 1,
      mounts: [
        { name: 'workspace', type: 'local_folder', path: '/workspace', root: '/tmp/workspace' },
      ],
    });

    const result = addApiTokenToConfig(config, {
      id: 'admin',
      permissions: [{ source: 'all', mode: 'write' }],
      plaintextToken: 'plain-token',
    });

    expect(result.client.permissions).toEqual([
      { path: '/**', actions: ['search', 'read', 'write'] },
    ]);
  });

  it('edits token metadata, ttl, and permissions without rotating the token secret', () => {
    const config = parseConfig({
      version: 1,
      mounts: [
        { name: 'notes', type: 'local_folder', path: '/notes', root: '/tmp/notes' },
        { name: 'workspace', type: 'local_folder', path: '/workspace', root: '/tmp/workspace', writeAccess: true },
      ],
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          description: 'old description',
          expiresAt: '2026-04-30T12:00:00.000Z',
          auth: { type: 'token', tokenHash: EXISTING_TOKEN_VERIFIER },
          permissions: [{ path: '/notes/**', actions: ['search', 'read'] }],
        },
      ],
    });

    const result = editApiTokenInConfig(config, 'codex', {
      name: 'Codex',
      description: 'updated description',
      expires: 'never',
      permissions: [{ source: '/workspace', mode: 'write' }],
    });

    expect(result.created).toBe(false);
    expect(result.plaintextToken).toBeUndefined();
    expect(result.client).toMatchObject({
      id: 'codex',
      name: 'Codex',
      description: 'updated description',
      auth: { type: 'token', tokenHash: EXISTING_TOKEN_VERIFIER },
      permissions: [
        { path: '/workspace/**', actions: ['search', 'read', 'write'] },
      ],
    });
    expect(result.client.expiresAt).toBeUndefined();
  });

  it('rotates a token secret while preserving metadata and permissions', () => {
    const config = parseConfig({
      version: 1,
      mounts: [
        { name: 'notes', type: 'local_folder', path: '/notes', root: '/tmp/notes' },
      ],
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          description: 'keep this',
          credentialVersion: 4,
          expiresAt: '2026-05-06T12:00:00.000Z',
          auth: { type: 'token', tokenHash: EXISTING_TOKEN_VERIFIER },
          permissions: [{ path: '/notes/**', actions: ['search', 'read'] }],
        },
      ],
    });

    const result = rotateApiTokenInConfig(config, 'codex', 'new-plaintext-token');

    expect(result.created).toBe(false);
    expect(result.plaintextToken).toBe('new-plaintext-token');
    expect(result.client).toMatchObject({
      id: 'codex',
      name: 'Codex CLI',
      description: 'keep this',
      credentialVersion: 5,
      expiresAt: '2026-05-06T12:00:00.000Z',
      permissions: [{ path: '/notes/**', actions: ['search', 'read'] }],
    });
    expect(result.client.auth.type).toBe('token');
    if (result.client.auth.type === 'token') {
      expect(result.client.auth.tokenHash).not.toBe(EXISTING_TOKEN_VERIFIER);
      expect(verifyApiToken('new-plaintext-token', result.client.auth.tokenHash)).toBe(true);
    }
  });

  it('preserves an expired token expiry unless rotate callers replace it', () => {
    const config = parseConfig({
      version: 1,
      mounts: [
        { name: 'notes', type: 'local_folder', path: '/notes', root: '/tmp/notes' },
      ],
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          expiresAt: '2026-04-30T06:24:31.469Z',
          auth: { type: 'token', tokenHash: EXISTING_TOKEN_VERIFIER },
          permissions: [{ path: '/notes/**', actions: ['search', 'read'] }],
        },
      ],
    });

    const result = rotateApiTokenInConfig(config, 'codex', 'new-plaintext-token', {
      now: Date.parse('2026-04-30T16:00:00.000Z'),
    });

    expect(result.client.expiresAt).toBe('2026-04-30T06:24:31.469Z');
    expect(result.client.credentialVersion).toBe(2);
    expect(result.client.auth.type).toBe('token');
    if (result.client.auth.type === 'token') {
      expect(verifyApiToken('new-plaintext-token', result.client.auth.tokenHash)).toBe(true);
    }
  });

  it('allows rotate callers to choose a replacement ttl', () => {
    const config = parseConfig({
      version: 1,
      mounts: [
        { name: 'notes', type: 'local_folder', path: '/notes', root: '/tmp/notes' },
      ],
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          expiresAt: '2026-05-06T12:00:00.000Z',
          auth: { type: 'token', tokenHash: EXISTING_TOKEN_VERIFIER },
          permissions: [{ path: '/notes/**', actions: ['search', 'read'] }],
        },
      ],
    });

    const result = rotateApiTokenInConfig(config, 'codex', 'new-plaintext-token', {
      ttl: '7d',
      now: Date.parse('2026-04-30T16:00:00.000Z'),
    });

    expect(result.client.expiresAt).toBe('2026-05-07T16:00:00.000Z');
  });

  it('rejects write permissions on read-only mounts', () => {
    const config = parseConfig({
      version: 1,
      mounts: [
        { name: 'document', type: 'local_folder', path: '/document', root: '/tmp/document' },
      ],
    });

    expect(() => addApiTokenToConfig(config, {
      id: 'codex',
      permissions: [{ source: 'document', mode: 'write' }],
      plaintextToken: 'plain-token',
    })).toThrow('read-only');
  });

  it('removes token clients and preserves non-token clients', () => {
    const config = parseConfig({
      version: 1,
      mounts: [
        { name: 'document', type: 'local_folder', path: '/document', root: '/tmp/document' },
      ],
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          auth: { type: 'token', tokenHash: EXISTING_TOKEN_VERIFIER },
          permissions: [{ path: '/document/**', actions: ['search', 'read'] }],
        },
        {
          id: 'chatgpt',
          name: 'ChatGPT',
          auth: { type: 'oauth', oauthClientIds: ['chatgpt-mvmt'] },
          permissions: [{ path: '/document/**', actions: ['search', 'read'] }],
        },
      ],
    });

    const next = removeApiTokenFromConfig(config, 'codex');

    expect(next.clients).toHaveLength(1);
    expect(next.clients?.[0].id).toBe('chatgpt');
  });
});
