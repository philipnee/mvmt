import { describe, expect, it } from 'vitest';
import fssync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { expandHome, loadConfig, parseConfig, readConfig, saveConfig } from '../src/config/loader.js';
import { MvmtConfig, resolveProxySourceId } from '../src/config/schema.js';

const SHA256_HEX_64 = 'a'.repeat(64);

describe('saveConfig', () => {
  it('writes a config file that loadConfig can read back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-save-config-'));
    const configPath = path.join(dir, 'config.yaml');
    const config = parseConfig({ version: 1, server: { port: 4242 } });

    await saveConfig(configPath, config);
    const loaded = loadConfig(configPath);
    expect(loaded.server.port).toBe(4242);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates the parent directory if it does not exist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-save-dir-'));
    const nestedPath = path.join(dir, 'nested', 'config.yaml');
    const config = parseConfig({ version: 1 });

    await saveConfig(nestedPath, config);
    expect(fssync.existsSync(nestedPath)).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('preserves valid config structure (round-trip test)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-round-trip-'));
    const configPath = path.join(dir, 'config.yaml');
    const config: MvmtConfig = parseConfig({
      version: 1,
      server: { port: 5000 },
      proxy: [{ name: 'test-proxy', transport: 'http', url: 'http://localhost:8080' }]
    });

    await saveConfig(configPath, config);
    const raw = readConfig(configPath);
    const loaded = parseConfig(raw);

    expect(loaded).toEqual(config);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('on non-Windows, writes with mode 0o600', async () => {
    if (process.platform === 'win32') return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-chmod-test-'));
    const configPath = path.join(dir, 'config.yaml');
    const config = parseConfig({ version: 1 });

    await saveConfig(configPath, config);
    const stat = await fs.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('parseConfig', () => {
  it('applies schema defaults', () => {
    const config = parseConfig({ version: 1 });

    expect(config.server.port).toBe(4141);
    expect(config.server.access).toBe('local');
    expect(config.proxy).toEqual([]);
    expect(config.mounts).toEqual([]);
  });

  it('parses local folder mounts for the prototype text index', () => {
    const config = parseConfig({
      version: 1,
      mounts: [{ name: 'workspace', type: 'local_folder', path: '/workspace', root: '~/code/mvmt', writeAccess: true }],
    });

    expect(config.mounts[0]).toMatchObject({
      name: 'workspace',
      type: 'local_folder',
      path: '/workspace',
      root: '~/code/mvmt',
      description: '',
      guidance: '',
      exclude: ['.git/**', 'node_modules/**', '.claude/**'],
      protect: ['.env', '.env.*', '.claude/**'],
      writeAccess: true,
      enabled: true,
    });
  });

  it('parses mount descriptions and guidance', () => {
    const config = parseConfig({
      version: 1,
      mounts: [
        {
          name: 'notes',
          type: 'local_folder',
          path: '/notes',
          root: '~/notes',
          description: 'Personal notes vault.',
          guidance: 'Use for reference. Do not write unless asked.',
        },
      ],
    });

    expect(config.mounts[0]).toMatchObject({
      description: 'Personal notes vault.',
      guidance: 'Use for reference. Do not write unless asked.',
    });
  });

  it('rejects duplicate source ids across mounts and proxy sources', () => {
    expect(() =>
      parseConfig({
        version: 1,
        proxy: [{ id: 'workspace', name: 'filesystem', command: 'npx' }],
        mounts: [{ name: 'workspace', type: 'local_folder', path: '/workspace', root: '/workspace' }],
      }),
    ).toThrow(/duplicate sourceId "workspace"/);
  });

  it('rejects duplicate mount paths', () => {
    expect(() =>
      parseConfig({
        version: 1,
        mounts: [
          { name: 'notes', type: 'local_folder', path: '/data', root: '/notes' },
          { name: 'archive', type: 'local_folder', path: '/data', root: '/archive' },
        ],
      }),
    ).toThrow(/duplicate mount path "\/data"/);
  });

  it('parses tunnel server access config', () => {
    const config = parseConfig({
      version: 1,
      server: {
        access: 'tunnel',
        tunnel: {
          provider: 'cloudflare-quick',
          command: 'cloudflared tunnel --url http://127.0.0.1:{port}',
          url: 'https://demo.trycloudflare.com',
        },
      },
    });

    expect(config.server.tunnel).toMatchObject({
      provider: 'cloudflare-quick',
      command: 'cloudflared tunnel --url http://127.0.0.1:{port}',
      url: 'https://demo.trycloudflare.com',
    });
  });

  it('defaults stdio proxy transport', () => {
    const config = parseConfig({
      version: 1,
      proxy: [{ name: 'filesystem', command: 'npx' }],
    });

    expect(config.proxy[0]).toMatchObject({
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: {},
      enabled: true,
    });
  });

  it('parses proxy write access policy', () => {
    const config = parseConfig({
      version: 1,
      proxy: [{ name: 'filesystem', command: 'npx', writeAccess: true }],
    });

    expect(config.proxy[0].writeAccess).toBe(true);
  });

  it('tolerates legacy proxy source metadata', () => {
    const config = parseConfig({
      version: 1,
      proxy: [{ name: 'filesystem', source: 'manual', command: 'npx' }],
    });

    expect(config.proxy[0]).toMatchObject({
      name: 'filesystem',
      source: 'manual',
      command: 'npx',
    });
  });

  it('parses pattern redactor plugin config', () => {
    const config = parseConfig({
      version: 1,
      plugins: [
        {
          name: 'pattern-redactor',
          mode: 'block',
          maxBytes: 4096,
          patterns: [
            {
              name: 'emails',
              regex: '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b',
              flags: 'gi',
              replacement: '[REDACTED:EMAIL]',
            },
          ],
        },
      ],
    });

    expect(config.plugins).toEqual([
      {
        name: 'pattern-redactor',
        enabled: true,
        mode: 'block',
        maxBytes: 4096,
        patterns: [
          {
            name: 'emails',
            regex: '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b',
            flags: 'gi',
            replacement: '[REDACTED:EMAIL]',
            enabled: true,
          },
        ],
      },
    ]);
  });

  it('rejects invalid pattern redactor config', () => {
    expect(() =>
      parseConfig({
        version: 1,
        plugins: [{ name: 'pattern-redactor', maxBytes: 32 }],
      }),
    ).toThrow('Invalid config');

    expect(() =>
      parseConfig({
        version: 1,
        plugins: [
          {
            name: 'pattern-redactor',
            patterns: [{ name: 'bad', regex: '[', replacement: '[REDACTED]' }],
          },
        ],
      }),
    ).toThrow('Invalid config');

    expect(() =>
      parseConfig({
        version: 1,
        plugins: [{ name: 'unknown-plugin' }],
      }),
    ).toThrow('Invalid config');
  });

  it('rejects invalid ports', () => {
    expect(() => parseConfig({ version: 1, server: { port: 70000 } })).toThrow('Invalid config');
  });

  it('rejects tunnel access without a tunnel command', () => {
    expect(() => parseConfig({ version: 1, server: { access: 'tunnel' } })).toThrow(
      'tunnel access requires "tunnel" config',
    );
  });

  it('rejects transport configs without required command or url', () => {
    expect(() => parseConfig({ version: 1, proxy: [{ name: 'bad', transport: 'stdio' }] })).toThrow(
      'stdio transport requires "command"',
    );
    expect(() => parseConfig({ version: 1, proxy: [{ name: 'bad', transport: 'http' }] })).toThrow(
      'http transport requires "url"',
    );
  });
});

describe('expandHome', () => {
  it('expands tilde paths', () => {
    expect(expandHome('~/notes')).not.toContain('~');
  });

  it('leaves normal paths unchanged', () => {
    expect(expandHome('/tmp/notes')).toBe('/tmp/notes');
  });
});

describe('loadConfig', () => {
  it('loads YAML config from an override path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-config-'));
    const configPath = path.join(dir, 'config.yaml');
    await fs.writeFile(
      configPath,
      ['version: 1', 'server:', '  port: 4142', 'proxy: []'].join('\n'),
      'utf-8',
    );

    expect(loadConfig(configPath)).toMatchObject({
      version: 1,
      server: { port: 4142 },
      proxy: [],
    });
  });
});

describe('client policy schema', () => {
  it('treats clients and semanticTools as optional (no behavior change for existing configs)', () => {
    const config = parseConfig({ version: 1 });
    expect(config.clients).toBeUndefined();
    expect(config.semanticTools).toBeUndefined();
  });

  it('parses a token-auth client with permissions referencing known sources', () => {
    const config = parseConfig({
      version: 1,
      proxy: [{ name: 'workspace', command: 'npx' }],
      obsidian: { path: '/vault' },
      clients: [
        {
          id: 'codex',
          name: 'Codex CLI',
          auth: { type: 'token', tokenHash: SHA256_HEX_64 },
          rawToolsEnabled: true,
          permissions: [
            { sourceId: 'workspace', actions: ['search', 'read', 'write'] },
            { sourceId: 'obsidian', actions: ['search', 'read'] },
          ],
        },
      ],
    });

    expect(config.clients).toHaveLength(1);
    expect(config.clients?.[0]).toMatchObject({
      id: 'codex',
      name: 'Codex CLI',
      auth: { type: 'token', tokenHash: SHA256_HEX_64 },
      rawToolsEnabled: true,
    });
  });

  it('parses an oauth-auth client with mapped client ids', () => {
    const config = parseConfig({
      version: 1,
      obsidian: { path: '/vault' },
      clients: [
        {
          id: 'chatgpt',
          name: 'ChatGPT',
          auth: { type: 'oauth', oauthClientIds: ['chatgpt-mvmt', 'chatgpt-mvmt-v2'] },
          permissions: [{ sourceId: 'obsidian', actions: ['search', 'read'] }],
        },
      ],
    });

    expect(config.clients?.[0].auth).toEqual({
      type: 'oauth',
      oauthClientIds: ['chatgpt-mvmt', 'chatgpt-mvmt-v2'],
    });
    expect(config.clients?.[0].rawToolsEnabled).toBe(false);
  });

  it('rejects unknown sourceId in client permissions', () => {
    expect(() =>
      parseConfig({
        version: 1,
        clients: [
          {
            id: 'codex',
            name: 'Codex',
            auth: { type: 'token', tokenHash: SHA256_HEX_64 },
            permissions: [{ sourceId: 'nonexistent', actions: ['read'] }],
          },
        ],
      }),
    ).toThrow(/unknown sourceId "nonexistent"/);
  });

  it('rejects duplicate client ids', () => {
    expect(() =>
      parseConfig({
        version: 1,
        clients: [
          { id: 'codex', name: 'A', auth: { type: 'token', tokenHash: SHA256_HEX_64 } },
          { id: 'codex', name: 'B', auth: { type: 'token', tokenHash: 'b'.repeat(64) } },
        ],
      }),
    ).toThrow(/duplicate client id "codex"/);
  });

  it('rejects duplicate tokenHash across clients (config order would otherwise be a security decision)', () => {
    expect(() =>
      parseConfig({
        version: 1,
        clients: [
          { id: 'codex', name: 'Codex', auth: { type: 'token', tokenHash: SHA256_HEX_64 } },
          { id: 'cursor', name: 'Cursor', auth: { type: 'token', tokenHash: SHA256_HEX_64 } },
        ],
      }),
    ).toThrow(/duplicate tokenHash/);
  });

  it('rejects duplicate tokenHash even when one is uppercase hex', () => {
    expect(() =>
      parseConfig({
        version: 1,
        clients: [
          { id: 'codex', name: 'Codex', auth: { type: 'token', tokenHash: SHA256_HEX_64 } },
          { id: 'cursor', name: 'Cursor', auth: { type: 'token', tokenHash: SHA256_HEX_64.toUpperCase() } },
        ],
      }),
    ).toThrow(/duplicate tokenHash/);
  });

  it('rejects duplicate oauthClientIds across OAuth clients', () => {
    expect(() =>
      parseConfig({
        version: 1,
        clients: [
          {
            id: 'chatgpt',
            name: 'ChatGPT',
            auth: { type: 'oauth', oauthClientIds: ['mvmt-shared'] },
          },
          {
            id: 'claude',
            name: 'Claude',
            auth: { type: 'oauth', oauthClientIds: ['mvmt-shared', 'claude-only'] },
          },
        ],
      }),
    ).toThrow(/oauth client_id "mvmt-shared" is already mapped/);
  });

  it('rejects an OAuth client_id duplicated within the same client', () => {
    expect(() =>
      parseConfig({
        version: 1,
        clients: [
          {
            id: 'chatgpt',
            name: 'ChatGPT',
            auth: { type: 'oauth', oauthClientIds: ['mvmt-shared', 'mvmt-shared'] },
          },
        ],
      }),
    ).toThrow(/oauth client_id "mvmt-shared" is already mapped/);
  });

  it('rejects malformed client id', () => {
    expect(() =>
      parseConfig({
        version: 1,
        clients: [
          {
            id: 'Has Spaces',
            name: 'bad',
            auth: { type: 'token', tokenHash: SHA256_HEX_64 },
          },
        ],
      }),
    ).toThrow(/lowercase alphanum/);
  });

  it('rejects malformed tokenHash', () => {
    expect(() =>
      parseConfig({
        version: 1,
        clients: [
          {
            id: 'codex',
            name: 'Codex',
            auth: { type: 'token', tokenHash: 'plaintext-token' },
          },
        ],
      }),
    ).toThrow(/64-char hex SHA-256/);
  });

  it('parses semanticTools and validates source references', () => {
    const config = parseConfig({
      version: 1,
      proxy: [{ name: 'workspace', command: 'npx' }],
      obsidian: { path: '/vault' },
      semanticTools: {
        searchPersonalContext: { enabled: true, sourceIds: ['workspace', 'obsidian'] },
        readContextItem: { sourceIds: ['workspace'] },
      },
    });

    expect(config.semanticTools?.searchPersonalContext?.sourceIds).toEqual(['workspace', 'obsidian']);
    expect(config.semanticTools?.readContextItem?.enabled).toBe(true);
  });

  it('rejects unknown sourceId in semanticTools', () => {
    expect(() =>
      parseConfig({
        version: 1,
        semanticTools: {
          searchPersonalContext: { sourceIds: ['nonexistent'] },
        },
      }),
    ).toThrow(/unknown sourceId "nonexistent"/);
  });

  it('uses proxy.id when set, falling back to name for source resolution', () => {
    const config = parseConfig({
      version: 1,
      proxy: [
        { id: 'workspace', name: 'filesystem', command: 'npx' },
      ],
      clients: [
        {
          id: 'codex',
          name: 'Codex',
          auth: { type: 'token', tokenHash: SHA256_HEX_64 },
          permissions: [{ sourceId: 'workspace', actions: ['read'] }],
        },
      ],
    });

    expect(resolveProxySourceId(config.proxy[0])).toBe('workspace');
    expect(config.clients?.[0].permissions[0].sourceId).toBe('workspace');
  });

  it('falls back to proxy.name when id is omitted', () => {
    const config = parseConfig({
      version: 1,
      proxy: [{ name: 'mempalace', command: '/venv/bin/python' }],
    });
    expect(resolveProxySourceId(config.proxy[0])).toBe('mempalace');
  });
});
