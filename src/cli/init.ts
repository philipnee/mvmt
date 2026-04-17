import { checkbox, confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import { getConfigPath } from '../config/loader.js';
import {
  DEFAULT_PATTERN_REDACTOR_PATTERNS,
  MvmtConfig,
  PatternRedactorPatternConfig,
  PluginConfig,
  TunnelConfig,
} from '../config/schema.js';
import { defaultTunnelCommand, missingTunnelDependency } from '../utils/tunnel.js';

export async function init(): Promise<void> {
  printBanner();

  const configPath = getConfigPath();
  if (await pathExists(configPath)) {
    const overwrite = await confirm({
      message: `Config already exists at ${configPath}. Overwrite?`,
      default: false,
    });

    if (!overwrite) {
      console.log(chalk.yellow('Aborted. Existing config unchanged.'));
      return;
    }
  }

  console.log('Configure the local data mvmt is allowed to expose.\n');

  const filesystemAccess = await promptForFilesystemFolders();

  let obsidianPath: string | undefined;
  let obsidianWriteAccess = false;

  console.log('\nChecking native connectors...\n');
  const vaults = await detectObsidianVaults();
  printAvailableConnectors(vaults);

  const wantObsidian = await confirm({
    message: 'Enable the Obsidian connector?',
    default: vaults.length > 0,
  });
  if (wantObsidian) {
    obsidianPath = await promptForObsidianVault(vaults);
    if (obsidianPath) {
      obsidianWriteAccess = await confirm({
        message: 'Allow the Obsidian connector to append to daily notes? Read-only is recommended.',
        default: false,
      });
    }
  }

  const plugins = await promptForPlugins();

  const portAnswer = await input({
    message: 'Server port',
    default: '4141',
    validate: (value) => {
      const port = Number(value);
      return Number.isInteger(port) && port > 0 && port <= 65535 ? true : 'Enter a port from 1 to 65535';
    },
  });
  const port = Number(portAnswer);
  const access = await promptForAccess(port);

  const config = buildConfig(
    obsidianPath,
    port,
    filesystemAccess.paths,
    filesystemAccess.writeAccess,
    obsidianWriteAccess,
    access,
    plugins,
  );

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml.stringify(config), 'utf-8');
  if (process.platform !== 'win32') {
    await fs.chmod(configPath, 0o600);
  }

  console.log(chalk.green(`\nConfig saved to ${configPath}`));
  console.log(`\nNext: run ${chalk.cyan('mvmt start')}\n`);
}

export function buildConfig(
  obsidianPath: string | undefined,
  port: number,
  filesystemPaths: string[] = [],
  filesystemWriteAccess = false,
  obsidianWriteAccess = false,
  access: { access: 'local' | 'tunnel'; tunnel?: TunnelConfig } = { access: 'local' },
  plugins: PluginConfig[] = [],
): MvmtConfig {
  const proxy: MvmtConfig['proxy'] = [];

  if (filesystemPaths.length > 0) {
    proxy.push({
      name: 'filesystem',
      source: 'manual',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', ...filesystemPaths],
      env: {},
      writeAccess: filesystemWriteAccess,
      enabled: true,
    });
  }

  return {
    version: 1,
    server: {
      port,
      allowedOrigins: [],
      access: access.access,
      ...(access.tunnel ? { tunnel: access.tunnel } : {}),
    },
    proxy,
    plugins,
    ...(obsidianPath
      ? { obsidian: { path: obsidianPath, enabled: true, writeAccess: obsidianWriteAccess } }
      : {}),
  };
}

async function promptForPlugins(): Promise<PluginConfig[]> {
  console.log('\nSecurity plugins\n');
  const selected = await checkbox<'pattern-redactor'>({
    message: 'Security plugins to enable:',
    choices: [
      {
        name: 'Pattern-based redactor - best-effort regex redaction for outbound tool results',
        value: 'pattern-redactor',
        checked: true,
      },
    ],
  });

  if (!selected.includes('pattern-redactor')) return [];

  const mode = await select<'warn' | 'redact' | 'block'>({
    message: 'What should the pattern-based redactor do when a configured pattern matches?',
    choices: [
      { name: 'Redact matches before returning tool output (recommended)', value: 'redact' },
      { name: 'Warn only; return output unchanged', value: 'warn' },
      { name: 'Block the whole tool result', value: 'block' },
    ],
  });

  const patterns = await checkbox<PatternRedactorPatternConfig>({
    message: 'Which default patterns should it use?',
    choices: DEFAULT_PATTERN_REDACTOR_PATTERNS.map((pattern) => ({
      name: pattern.name,
      value: pattern,
      checked: true,
    })),
    validate: (value) => (value.length > 0 ? true : 'Select at least one pattern or disable the plugin.'),
  });

  const maxBytesAnswer = await input({
    message: 'Max bytes to scan per text result',
    default: String(1024 * 1024),
    validate: (value) => {
      const maxBytes = Number(value);
      return Number.isInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 10 * 1024 * 1024
        ? true
        : 'Enter a value from 1024 to 10485760';
    },
  });

  return [
    {
      name: 'pattern-redactor',
      enabled: true,
      mode,
      maxBytes: Number(maxBytesAnswer),
      patterns: patterns.length > 0 ? patterns : DEFAULT_PATTERN_REDACTOR_PATTERNS,
    },
  ];
}

async function promptForAccess(port: number): Promise<{ access: 'local' | 'tunnel'; tunnel?: TunnelConfig }> {
  const access = await select<'local' | 'tunnel'>({
    message: 'How should mvmt be accessible?',
    choices: [
      { name: `Local only (localhost:${port})`, value: 'local' },
      { name: 'Tunnel (get a public URL)', value: 'tunnel' },
    ],
  });

  if (access === 'local') return { access: 'local' };

  while (true) {
    const provider = await select<'cloudflare-quick' | 'localhost-run'>({
      message: 'Which tunnel?',
      choices: [
        { name: 'Cloudflare Quick Tunnel (recommended, requires cloudflared)', value: 'cloudflare-quick' },
        { name: 'localhost.run (fallback, less stable)', value: 'localhost-run' },
      ],
    });

    const tunnel: TunnelConfig = {
      provider,
      command: defaultTunnelCommand(provider),
    };
    const missingDependency = missingTunnelDependency(tunnel);
    if (missingDependency) {
      printMissingTunnelDependencyWarning(missingDependency);
      console.log(chalk.dim('Choose another tunnel provider, or press Ctrl+C and install the missing command first.'));
      continue;
    }

    return {
      access: 'tunnel',
      tunnel,
    };
  }
}

function printMissingTunnelDependencyWarning(command: string): void {
  if (command === 'cloudflared') {
    console.log(chalk.yellow('Cloudflare Quick Tunnel requires `cloudflared`, but it is not installed or not on PATH.'));
    console.log(chalk.yellow('Install it with `brew install cloudflared`, or choose another tunnel provider.'));
    return;
  }
  console.log(chalk.yellow(`Tunnel dependency is missing: ${command}`));
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

async function promptForObsidianVault(vaults: string[]): Promise<string | undefined> {
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

  const resolved = expandHome(chosenPath);
  try {
    await fs.access(path.join(resolved, '.obsidian'));
    return resolved;
  } catch {
    console.log(chalk.red(`Not a valid Obsidian vault: ${resolved}`));
    console.log(chalk.dim('Expected a .obsidian directory inside the path. Skipping Obsidian.'));
    return undefined;
  }
}

async function promptForFilesystemFolders(): Promise<{ paths: string[]; writeAccess: boolean }> {
  const wantFilesystem = await confirm({
    message: 'Expose specific local folders through mvmt?',
    default: false,
  });
  if (!wantFilesystem) return { paths: [], writeAccess: false };

  const folders = new Set<string>();

  while (true) {
    const folder = await input({
      message: folders.size === 0 ? 'Folder path to allow:' : 'Another folder path to allow:',
      validate: async (value) => {
        if (!value.trim()) return 'Enter a folder path';
        const resolved = expandHome(value.trim());
        try {
          const stat = await fs.stat(resolved);
          return stat.isDirectory() ? true : 'Path must be a directory';
        } catch {
          return 'Directory does not exist';
        }
      },
    });

    folders.add(expandHome(folder.trim()));

    const addAnother = await confirm({
      message: 'Allow another folder?',
      default: false,
    });
    if (!addAnother) break;
  }

  const paths = [...folders].sort((a, b) => a.localeCompare(b));
  const writeAccess = await confirm({
    message: 'Allow filesystem write tools for these folders? Read-only is recommended.',
    default: false,
  });

  return { paths, writeAccess };
}

function printBanner(): void {
  console.log(`\n${chalk.bold('mvmt')} - local MCP hub\n`);
}

function printAvailableConnectors(vaults: string[]): void {
  console.log('Available connectors:');
  console.log(
    `  - Obsidian ${chalk.dim(
      vaults.length > 0
        ? `detected ${vaults.length} vault${vaults.length === 1 ? '' : 's'}`
        : 'no vault auto-detected; manual path supported',
    )}`,
  );
  console.log('');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith(`~${path.sep}`)) return path.join(os.homedir(), inputPath.slice(2));
  return path.resolve(inputPath);
}
