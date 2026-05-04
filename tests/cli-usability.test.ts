import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import { parseConfig, readConfig, saveConfig } from '../src/config/loader.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const cliArgs = ['--import', 'tsx', 'bin/mvmt.ts', '--no-update-check'];

describe('CLI usability', () => {
  it('shows examples in top-level help', async () => {
    const { stdout } = await runCli(['--help']);

    expect(stdout).toContain('Mount selected local folders and serve them over MCP');
    expect(stdout).toContain('Examples:');
    expect(stdout).toContain('mvmt serve --path ~/Documents');
    expect(stdout).toContain('serve one read-only folder for this run');
  });

  it('suggests close command names for typos', async () => {
    const result = await runCliAllowFailure(['mountz']);

    expect(result.code).toBe(1);
    expect(result.output).toContain("unknown command 'mountz'");
    expect(result.output).toContain('Did you mean mounts?');
  });

  it('prints mounts as JSON for scripts', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-cli-usability-'));
    const configPath = path.join(tmp, 'config.yaml');
    try {
      await saveConfig(configPath, parseConfig({
        version: 1,
        mounts: [{ name: 'notes', type: 'local_folder', path: '/notes', root: '/tmp/notes' }],
      }));

      const { stdout } = await runCli(['mounts', '--config', configPath, '--json']);
      expect(JSON.parse(stdout)).toMatchObject({
        mounts: [
          {
            name: 'notes',
            path: '/notes',
            root: '/tmp/notes',
            enabled: true,
            writeAccess: false,
          },
        ],
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('removes a mount non-interactively with --yes', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-cli-usability-'));
    const configPath = path.join(tmp, 'config.yaml');
    try {
      await saveConfig(configPath, parseConfig({
        version: 1,
        mounts: [{ name: 'notes', type: 'local_folder', path: '/notes', root: '/tmp/notes' }],
      }));

      const { stdout } = await runCli(['mounts', 'remove', 'notes', '--config', configPath, '--yes']);
      expect(stdout).toContain('Mount notes removed');

      const { stdout: json } = await runCli(['mounts', '--config', configPath, '--json']);
      expect(JSON.parse(json)).toEqual({ mounts: [] });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('gives a next step when reindex has no mounts', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-cli-usability-'));
    const configPath = path.join(tmp, 'config.yaml');
    try {
      await saveConfig(configPath, parseConfig({ version: 1 }));

      const result = await runCliAllowFailure(['reindex', '--config', configPath]);
      expect(result.code).toBe(1);
      expect(result.output).toContain('No mounts configured.');
      expect(result.output).toContain('mvmt mounts add <name> <folder>');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('gives non-interactive serve users mount setup commands when no mounts exist', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-cli-usability-'));
    const configPath = path.join(tmp, 'config.yaml');
    try {
      await saveConfig(configPath, parseConfig({ version: 1 }));

      const result = await runCliAllowFailure(['serve', '--config', configPath]);
      expect(result.code).toBe(1);
      expect(result.output).toContain('No mounts loaded. Nothing to serve.');
      expect(result.output).toContain('mvmt mounts add <name> <folder>');
      expect(result.output).toContain('mvmt serve --path <dir>');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects non-interactive mount roots that do not exist', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-cli-usability-'));
    const configPath = path.join(tmp, 'config.yaml');
    const missingRoot = path.join(tmp, 'missing');
    try {
      await saveConfig(configPath, parseConfig({ version: 1 }));

      const result = await runCliAllowFailure([
        'mounts',
        'add',
        'missing',
        missingRoot,
        '--config',
        configPath,
      ]);
      expect(result.code).toBe(1);
      expect(result.output).toContain(`Folder not found: ${missingRoot}`);
      expect(result.output).not.toContain('Error:');
      expect(result.output).not.toContain('at async');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('can disable tunnel access without removing saved tunnel details', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-cli-usability-'));
    const configPath = path.join(tmp, 'config.yaml');
    try {
      await saveConfig(configPath, parseConfig({
        version: 1,
        server: {
          access: 'tunnel',
          tunnel: {
            provider: 'custom',
            command: 'cloudflared tunnel --config ~/.cloudflared/mvmt.yml run',
            url: 'https://mvmt.example.com',
          },
        },
      }));

      const { stdout } = await runCli(['tunnel', 'disable', '--config', configPath]);
      expect(stdout).toContain('Tunnel access disabled');

      const updated = readConfig(configPath);
      expect(updated.server.access).toBe('local');
      expect(updated.server.tunnel?.url).toBe('https://mvmt.example.com');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('creates and lists scoped API tokens non-interactively', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-cli-usability-'));
    const configPath = path.join(tmp, 'config.yaml');
    const mountRoot = path.join(tmp, 'notes');
    try {
      await fs.mkdir(mountRoot);
      await saveConfig(configPath, parseConfig({
        version: 1,
        mounts: [{ name: 'notes', type: 'local_folder', path: '/notes', root: mountRoot }],
      }));

      const { stdout } = await runCli([
        'token',
        'add',
        'codex',
        '--config',
        configPath,
        '--scope',
        'notes:read',
        '--name',
        'Codex CLI',
        '--description',
        'Local Codex token',
        '--expires',
        '7d',
      ]);
      expect(stdout).toContain('Token created.');
      expect(stdout).toContain('Name:    codex');
      expect(stdout).toContain('Scope:   notes:read');
      expect(stdout).toContain('Token:   mvmt_t_');
      expect(stdout).toContain('Expires:');
      expect(stdout).toContain('For OAuth clients, paste this token into the mvmt approval page');

      const { stdout: list } = await runCli(['token', '--config', configPath]);
      expect(list).toContain('NAME');
      expect(list).toContain('SCOPE');
      expect(list).toContain('codex');
      expect(list).toContain('notes:read');
      expect(list).toContain('(any)');

      const { stdout: json } = await runCli(['token', '--config', configPath, '--json']);
      expect(JSON.parse(json)).toMatchObject({
        tokens: [
          {
            name: 'codex',
            scope: 'notes:read',
            client: null,
            createdAt: expect.any(String),
            lastUsedAt: null,
            expiresAt: expect.any(String),
          },
        ],
      });
      await fs.writeFile(path.join(tmp, 'audit.log'), `${JSON.stringify({
        ts: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
        event: 'token.use',
        connectorId: 'mvmt',
        tool: 'search',
        clientId: 'codex',
        name: 'codex',
        argKeys: [],
        argPreview: '{}',
        isError: false,
        durationMs: 1,
      })}\n`, 'utf-8');
      const { stdout: listWithUse } = await runCli(['token', '--config', configPath]);
      expect(listWithUse).toContain('12 minutes ago');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('shows a safe empty state for token listing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-cli-usability-'));
    const configPath = path.join(tmp, 'config.yaml');
    try {
      await saveConfig(configPath, parseConfig({ version: 1 }));

      const { stdout } = await runCli(['token', '--config', configPath]);
      expect(stdout).toContain('No tokens configured.');
      expect(stdout).toContain('Create one with: mvmt token add <name>');

      const { stdout: json } = await runCli(['token', '--config', configPath, '--json']);
      expect(JSON.parse(json)).toEqual({ tokens: [] });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects API-token write access that exceeds the mount base permission', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-cli-usability-'));
    const configPath = path.join(tmp, 'config.yaml');
    const mountRoot = path.join(tmp, 'notes');
    try {
      await fs.mkdir(mountRoot);
      await saveConfig(configPath, parseConfig({
        version: 1,
        mounts: [{ name: 'notes', type: 'local_folder', path: '/notes', root: mountRoot }],
      }));

      const result = await runCliAllowFailure([
        'tokens',
        'add',
        'codex',
        '--config',
        configPath,
        '--write',
        '/notes',
      ]);
      expect(result.code).toBe(1);
      expect(result.output).toContain('Mount /notes is read-only');
      expect(result.output).not.toContain('Error:');
      expect(result.output).not.toContain('at async');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('edits a scoped API token non-interactively', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-cli-usability-'));
    const configPath = path.join(tmp, 'config.yaml');
    const mountRoot = path.join(tmp, 'workspace');
    try {
      await fs.mkdir(mountRoot);
      await saveConfig(configPath, parseConfig({
        version: 1,
        mounts: [{ name: 'workspace', type: 'local_folder', path: '/workspace', root: mountRoot, writeAccess: true }],
      }));

      await runCli([
        'token',
        'add',
        'codex',
        '--config',
        configPath,
        '--read',
        '/workspace',
      ]);
      const { stdout } = await runCli([
        'token',
        'edit',
        'codex',
        '--config',
        configPath,
        '--scope',
        'workspace:write',
        '--description',
        'Updated token',
        '--expires',
        'never',
      ]);
      expect(stdout).toContain('Token updated.');
      expect(stdout).toContain('Existing token value was not changed.');

      const { stdout: list } = await runCli(['token', '--config', configPath]);
      expect(list).toContain('workspace:write');
      expect(list).toContain('never');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rotates a scoped API token non-interactively and prints the replacement once', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-cli-usability-'));
    const configPath = path.join(tmp, 'config.yaml');
    const mountRoot = path.join(tmp, 'notes');
    try {
      await fs.mkdir(mountRoot);
      await saveConfig(configPath, parseConfig({
        version: 1,
        mounts: [{ name: 'notes', type: 'local_folder', path: '/notes', root: mountRoot }],
      }));

      await runCli([
        'token',
        'add',
        'codex',
        '--config',
        configPath,
        '--read',
        '/notes',
      ]);
      const { stdout } = await runCli(['token', 'rotate', 'codex', '--config', configPath, '--yes']);

      expect(stdout).toContain('Token rotated.');
      expect(stdout).toContain('Token:   mvmt_t_');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [...cliArgs, ...args], { cwd: root });
}

async function runCliAllowFailure(args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await runCli(args);
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}
