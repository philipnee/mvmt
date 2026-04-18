import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/cli/init.js';

describe('init helpers', () => {
  it('builds config from explicit local scopes and native Obsidian path', () => {
    const config = buildConfig('/vault', 4141);

    expect(config).toMatchObject({
      version: 1,
      server: { port: 4141, access: 'local' },
      proxy: [],
      obsidian: { path: '/vault', enabled: true },
    });
  });

  it('adds a manual filesystem proxy for explicit folder access', () => {
    const config = buildConfig(undefined, 4141, ['/Users/me/project', '/Users/me/docs']);

    expect(config.proxy).toEqual([
      {
        name: 'filesystem',
        source: 'manual',
        transport: 'stdio',
        command: 'npx',
        args: [
          '-y',
          '@modelcontextprotocol/server-filesystem',
          '/Users/me/project',
          '/Users/me/docs',
        ],
        env: {},
        writeAccess: false,
        enabled: true,
      },
    ]);
  });

  it('records explicit filesystem write access only when requested', () => {
    const config = buildConfig(undefined, 4141, ['/Users/me/project'], true);

    expect(config.proxy[0]).toMatchObject({
      name: 'filesystem',
      writeAccess: true,
    });
  });

  it('does not create a proxy when no filesystem folders are selected', () => {
    const config = buildConfig(undefined, 4141);

    expect(config.proxy).toEqual([]);
  });

  it('records Obsidian write access only when requested', () => {
    const config = buildConfig('/vault', 4141, [], false, true);

    expect(config.obsidian).toMatchObject({
      path: '/vault',
      enabled: true,
      writeAccess: true,
    });
  });

  it('records tunnel access when requested', () => {
    const config = buildConfig('/vault', 4141, [], false, false, {
      access: 'tunnel',
      tunnel: {
        provider: 'cloudflare-quick',
        command: 'cloudflared tunnel --url http://127.0.0.1:{port}',
        url: 'https://demo.trycloudflare.com',
      },
    });

    expect(config.server).toMatchObject({
      access: 'tunnel',
      tunnel: {
        provider: 'cloudflare-quick',
        command: 'cloudflared tunnel --url http://127.0.0.1:{port}',
        url: 'https://demo.trycloudflare.com',
      },
    });
  });

  it('records selected security plugins', () => {
    const config = buildConfig(undefined, 4141, [], false, false, { access: 'local' }, [
      {
        name: 'pattern-redactor',
        enabled: true,
        mode: 'redact',
        maxBytes: 1024 * 1024,
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

    expect(config.plugins).toEqual([
      {
        name: 'pattern-redactor',
        enabled: true,
        mode: 'redact',
        maxBytes: 1024 * 1024,
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
});
