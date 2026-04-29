import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/cli/init.js';
import { filesystemSetupDefinition } from '../src/connectors/filesystem-setup.js';

describe('init helpers', () => {
  it('adds local folder mounts for explicit folder access', () => {
    const base = buildConfig({ port: 4141 });
    const config = filesystemSetupDefinition.apply(base, {
      paths: ['/Users/me/project', '/Users/me/docs'],
      writeAccess: false,
    });

    expect(config.mounts).toEqual([
      {
        name: 'project',
        type: 'local_folder',
        path: '/project',
        root: '/Users/me/project',
        description: '',
        guidance: '',
        exclude: ['.git/**', 'node_modules/**', '.claude/**'],
        protect: ['.env', '.env.*', '.claude/**'],
        writeAccess: false,
        enabled: true,
      },
      {
        name: 'docs',
        type: 'local_folder',
        path: '/docs',
        root: '/Users/me/docs',
        description: '',
        guidance: '',
        exclude: ['.git/**', 'node_modules/**', '.claude/**'],
        protect: ['.env', '.env.*', '.claude/**'],
        writeAccess: false,
        enabled: true,
      },
    ]);
  });

  it('records explicit filesystem write access only when requested', () => {
    const base = buildConfig({ port: 4141 });
    const config = filesystemSetupDefinition.apply(base, {
      paths: ['/Users/me/project'],
      writeAccess: true,
    });

    expect(config.mounts[0]).toMatchObject({
      name: 'project',
      root: '/Users/me/project',
      writeAccess: true,
    });
  });

  it('sanitizes folder names into stable mount names without regex trimming', () => {
    const base = buildConfig({ port: 4141 });
    const config = filesystemSetupDefinition.apply(base, {
      paths: ['/Users/me/---My Project---', '/Users/me/你好'],
      writeAccess: false,
    });

    expect(config.mounts.map((mount) => [mount.name, mount.path])).toEqual([
      ['my-project', '/my-project'],
      ['folder', '/folder'],
    ]);
  });

  it('does not create a proxy when no connector is applied', () => {
    const config = buildConfig({ port: 4141 });

    expect(config.proxy).toEqual([]);
  });

  it('records tunnel access when requested', () => {
    const config = buildConfig({
      port: 4141,
      access: {
        access: 'tunnel',
        tunnel: {
          provider: 'cloudflare-quick',
          command: 'cloudflared tunnel --url http://127.0.0.1:{port}',
          url: 'https://demo.trycloudflare.com',
        },
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
    const config = buildConfig({
      port: 4141,
      plugins: [
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
      ],
    });

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
