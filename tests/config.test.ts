import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { expandHome, loadConfig, parseConfig } from '../src/config/loader.js';

describe('parseConfig', () => {
  it('applies schema defaults', () => {
    const config = parseConfig({ version: 1 });

    expect(config.server.port).toBe(4141);
    expect(config.server.access).toBe('local');
    expect(config.proxy).toEqual([]);
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
