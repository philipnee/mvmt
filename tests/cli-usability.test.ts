import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import { parseConfig, saveConfig } from '../src/config/loader.js';

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
