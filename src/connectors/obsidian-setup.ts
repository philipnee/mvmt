import { confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ObsidianConfig } from '../config/schema.js';
import { resolveSetupPath } from './setup-paths.js';

export interface ObsidianConfigInput {
  path: string;
  writeAccess: boolean;
}

export function createObsidianConfig(obsidian: ObsidianConfigInput): ObsidianConfig {
  return {
    path: obsidian.path,
    enabled: true,
    writeAccess: obsidian.writeAccess,
  };
}

export async function detectObsidianVaults(): Promise<string[]> {
  const candidates = [
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Obsidian'),
    path.join(os.homedir(), 'vaults'),
    os.homedir(),
  ];
  if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'));
  }
  const vaults = new Set<string>();

  for (const dir of candidates) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const vaultPath = path.join(dir, entry.name);
      try {
        await fs.access(path.join(vaultPath, '.obsidian'));
        vaults.add(vaultPath);
      } catch {
        // Not a vault.
      }
    }
  }

  return [...vaults].sort((a, b) => a.localeCompare(b));
}

export async function countNotes(vaultPath: string): Promise<number> {
  let count = 0;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        count += 1;
      }
    }
  }

  await walk(vaultPath);
  return count;
}

export async function promptForObsidianSetup(vaults: string[]): Promise<ObsidianConfigInput | undefined> {
  const wantObsidian = await confirm({
    message: 'Enable the Obsidian connector?',
    default: vaults.length > 0,
  });
  if (!wantObsidian) return undefined;

  const chosenPath = await promptForObsidianVault(vaults);
  if (!chosenPath) return undefined;

  const writeAccess = await confirm({
    message: 'Allow the Obsidian connector to append to daily notes? Read-only is recommended.',
    default: false,
  });

  return {
    path: chosenPath,
    writeAccess,
  };
}

export async function promptForObsidianVault(vaults: string[]): Promise<string | undefined> {
  let chosenPath: string;
  if (vaults.length === 1) {
    const vaultPath = vaults[0];
    const useVault = await confirm({
      message: `Use ${vaultPath} (${(await countNotes(vaultPath)).toLocaleString()} notes)?`,
      default: true,
    });
    chosenPath = useVault ? vaultPath : await input({ message: 'Vault path:' });
  } else if (vaults.length > 1) {
    const choices = await Promise.all(
      vaults.map(async (vaultPath) => ({
        name: `${vaultPath} ${chalk.dim(`(${(await countNotes(vaultPath)).toLocaleString()} notes)`)}`,
        value: vaultPath,
      })),
    );
    chosenPath = await select({
      message: 'Which Obsidian vault should mvmt connect?',
      choices: [...choices, { name: 'Enter another path', value: '__manual__' }],
    });

    if (chosenPath === '__manual__') {
      chosenPath = await input({ message: 'Vault path:' });
    }
  } else {
    chosenPath = await input({ message: 'Vault path:' });
  }

  const resolved = resolveSetupPath(chosenPath);
  try {
    await fs.access(path.join(resolved, '.obsidian'));
    return resolved;
  } catch {
    console.log(chalk.red(`Not a valid Obsidian vault: ${resolved}`));
    console.log(chalk.dim('Expected a .obsidian directory inside the path. Skipping Obsidian.'));
    return undefined;
  }
}
