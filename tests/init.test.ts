import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { buildConfig, findExecutableOnPath, readShebangCommand } from '../src/cli/init.js';

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

  it('adds a MemPalace proxy when configured', () => {
    const config = buildConfig(undefined, 4141, [], false, false, { access: 'local' }, [], {
      command: '/venv/bin/python',
      palacePath: '/Users/me/.mempalace/palace',
      writeAccess: false,
    });

    expect(config.proxy).toEqual([
      {
        name: 'mempalace',
        source: 'mempalace',
        transport: 'stdio',
        command: '/venv/bin/python',
        args: ['-m', 'mempalace.mcp_server', '--palace', '/Users/me/.mempalace/palace'],
        env: {},
        writeAccess: false,
        enabled: true,
      },
    ]);
  });

  it('finds executables on an explicit PATH', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-init-'));
    const executable = path.join(dir, 'mempalace');
    await fs.writeFile(executable, '#!/usr/bin/env node\n', 'utf-8');
    await fs.chmod(executable, 0o755);

    await expect(findExecutableOnPath('mempalace', dir)).resolves.toBe(executable);
    await expect(findExecutableOnPath('missing', dir)).resolves.toBeUndefined();
  });

  it('reads absolute shebang commands and ignores env shebangs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-init-'));
    const python = path.join(dir, 'python');
    const pipxScript = path.join(dir, 'mempalace');
    const envScript = path.join(dir, 'mempalace-env');

    await fs.writeFile(python, '', 'utf-8');
    await fs.writeFile(pipxScript, `#!${python}\n`, 'utf-8');
    await fs.writeFile(envScript, '#!/usr/bin/env python\n', 'utf-8');

    await expect(readShebangCommand(pipxScript)).resolves.toBe(python);
    await expect(readShebangCommand(envScript)).resolves.toBeUndefined();
  });
});
