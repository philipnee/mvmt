import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectMemPalace } from '../src/connectors/mempalace-setup.js';
import { detectObsidianVaults } from '../src/connectors/obsidian-setup.js';

const originalPath = process.env.PATH;

describe('connector setup detection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = originalPath;
  });

  it('detects Obsidian vaults and skips hidden directories', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-setup-home-'));
    const documentsDir = path.join(home, 'Documents');
    const vaultPath = path.join(documentsDir, 'Vault');
    const hiddenVaultPath = path.join(documentsDir, '.HiddenVault');
    const nonVaultPath = path.join(documentsDir, 'NotAVault');

    await fs.mkdir(path.join(vaultPath, '.obsidian'), { recursive: true });
    await fs.mkdir(path.join(hiddenVaultPath, '.obsidian'), { recursive: true });
    await fs.mkdir(nonVaultPath, { recursive: true });

    vi.spyOn(os, 'homedir').mockReturnValue(home);

    await expect(detectObsidianVaults()).resolves.toEqual([vaultPath]);
  });

  it('detects MemPalace command and palace path from local config', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-mempalace-home-'));
    const binDir = path.join(home, 'bin');
    const pythonPath = path.join(binDir, 'python');
    const executablePath = path.join(binDir, 'mempalace');
    const palacePath = path.join(home, 'palaces', 'default');

    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.dirname(palacePath), { recursive: true });
    await fs.mkdir(path.join(home, '.mempalace'), { recursive: true });
    await fs.writeFile(pythonPath, '', 'utf-8');
    await fs.chmod(pythonPath, 0o755);
    await fs.writeFile(executablePath, `#!${pythonPath}\n`, 'utf-8');
    await fs.chmod(executablePath, 0o755);
    await fs.mkdir(palacePath, { recursive: true });
    await fs.writeFile(
      path.join(home, '.mempalace', 'config.json'),
      JSON.stringify({ palace_path: palacePath }),
      'utf-8',
    );

    vi.spyOn(os, 'homedir').mockReturnValue(home);
    process.env.PATH = binDir;

    await expect(detectMemPalace()).resolves.toEqual({
      executable: executablePath,
      command: pythonPath,
      palacePath,
    });
  });

  it('returns an empty detection result when MemPalace is not installed', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-mempalace-empty-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    process.env.PATH = '';

    await expect(detectMemPalace()).resolves.toEqual({});
  });
});
