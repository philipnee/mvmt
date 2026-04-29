import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  addApiTokenToConfig,
  removeApiTokenFromConfig,
} from '../src/cli/api-tokens.js';
import { parseConfig } from '../src/config/loader.js';

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
      plaintextToken: 'plain-token',
      permissions: [{ mount: '/document', mode: 'read' }],
    });

    expect(result.created).toBe(true);
    expect(result.plaintextToken).toBe('plain-token');
    expect(result.client).toMatchObject({
      id: 'codex',
      name: 'Codex CLI',
      auth: {
        type: 'token',
        tokenHash: createHash('sha256').update('plain-token', 'utf8').digest('hex'),
      },
      rawToolsEnabled: false,
      permissions: [{ path: '/document/**', actions: ['search', 'read'] }],
    });
  });

  it('updates an existing token permission without rotating its secret', () => {
    const config = parseConfig({
      version: 1,
      mounts: [
        { name: 'workspace', type: 'local_folder', path: '/workspace', root: '/tmp/workspace', writeAccess: true },
      ],
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          auth: { type: 'token', tokenHash: 'a'.repeat(64) },
          permissions: [{ path: '/workspace/**', actions: ['search', 'read'] }],
        },
      ],
    });

    const result = addApiTokenToConfig(config, {
      id: 'codex',
      permissions: [{ mount: 'workspace', mode: 'write' }],
    });

    expect(result.created).toBe(false);
    expect(result.plaintextToken).toBeUndefined();
    expect(result.client.auth).toEqual({ type: 'token', tokenHash: 'a'.repeat(64) });
    expect(result.client.permissions).toEqual([
      { path: '/workspace/**', actions: ['search', 'read', 'write'] },
    ]);
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
      permissions: [{ mount: 'document', mode: 'write' }],
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
          auth: { type: 'token', tokenHash: 'a'.repeat(64) },
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
