import { checkbox, confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { getConfigPath, saveConfig } from '../config/loader.js';
import {
  DEFAULT_PATTERN_REDACTOR_PATTERNS,
  MvmtConfig,
  PatternRedactorPatternConfig,
  PluginConfig,
  TunnelConfig,
} from '../config/schema.js';
import type { DetectedMemPalace } from '../connectors/mempalace-setup.js';
import { getSetupRegistry } from '../connectors/setup-registry.js';
import { pathExists, resolveSetupPath } from '../connectors/setup-paths.js';
import {
  cloudflareNamedTunnelCommand,
  defaultTunnelCommand,
  missingTunnelDependency,
  normalizeTunnelBaseUrl,
} from '../utils/tunnel.js';

export interface SetupConfigOptions {
  config?: string;
  promptOnOverwrite?: boolean;
  printNextStep?: boolean;
}

export async function setupConfig(
  options: SetupConfigOptions = {},
): Promise<{ config: MvmtConfig; configPath: string } | undefined> {
  printBanner();

  const configPath = options.config ? resolveSetupPath(options.config) : getConfigPath();
  if (options.promptOnOverwrite !== false && await pathExists(configPath)) {
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

  console.log('Checking available connectors...\n');
  const setupRegistry = getSetupRegistry();
  const detections = new Map(
    await Promise.all(
      setupRegistry.map(async (definition) => [definition.id, await definition.detect()] as const),
    ),
  );

  const vaults = (detections.get('obsidian') as string[] | undefined) ?? [];
  const detectedMemPalace = (detections.get('mempalace') as DetectedMemPalace | undefined) ?? {};
  printAvailableConnectors(vaults, detectedMemPalace);

  const applySelections: Array<(config: MvmtConfig) => MvmtConfig> = [];
  for (const definition of setupRegistry) {
    const detected = detections.get(definition.id);
    const input = await definition.prompt(detected);
    if (input !== undefined) {
      applySelections.push((config) => definition.apply(config, input));
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

  let config = buildConfig({ port, access, plugins });
  for (const applySelection of applySelections) {
    config = applySelection(config);
  }

  await saveConfig(configPath, config);

  console.log(chalk.green(`\nConfig saved to ${configPath}`));
  if (options.printNextStep !== false) {
    console.log(`\nNext: run ${chalk.cyan('mvmt serve')}\n`);
  } else {
    console.log('');
  }

  return { config, configPath };
}

export async function init(options: SetupConfigOptions = {}): Promise<void> {
  await setupConfig(options);
}

export interface BuildConfigInput {
  port: number;
  access?: { access: 'local' | 'tunnel'; tunnel?: TunnelConfig };
  plugins?: PluginConfig[];
}

export function buildConfig(input: BuildConfigInput): MvmtConfig {
  const access = input.access ?? { access: 'local' };
  return {
    version: 1,
    server: {
      port: input.port,
      allowedOrigins: [],
      access: access.access,
      ...(access.tunnel ? { tunnel: access.tunnel } : {}),
    },
    proxy: [],
    mounts: [],
    plugins: input.plugins ?? [],
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
    const provider = await select<'cloudflare-quick' | 'cloudflare-named' | 'localhost-run' | 'custom'>({
      message: 'Which tunnel?',
      choices: [
        { name: 'Cloudflare Quick Tunnel (temporary URL, requires cloudflared)', value: 'cloudflare-quick' },
        { name: 'Cloudflare Named Tunnel (stable domain, requires existing cloudflared config)', value: 'cloudflare-named' },
        { name: 'localhost.run (fallback, less stable)', value: 'localhost-run' },
        { name: 'Custom tunnel command', value: 'custom' },
      ],
    });

    const tunnel = await promptForTunnelDetails(provider);
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

async function promptForTunnelDetails(
  provider: 'cloudflare-quick' | 'cloudflare-named' | 'localhost-run' | 'custom',
): Promise<TunnelConfig> {
  if (provider === 'cloudflare-named') {
    console.log(chalk.dim('Use this after creating a Cloudflare named tunnel and DNS route.'));
    const configPath = await input({
      message: 'Cloudflared config file',
      default: '~/.cloudflared/config.yml',
      validate: async (value) => {
        const resolved = resolveSetupPath(value.trim());
        return (await pathExists(resolved)) ? true : `File not found: ${resolved}`;
      },
    });
    const publicUrl = await input({
      message: 'Public base URL',
      default: 'https://example.com',
      validate: validatePublicUrlInput,
    });
    return {
      provider: 'custom',
      command: cloudflareNamedTunnelCommand(resolveSetupPath(configPath.trim())),
      url: normalizeTunnelBaseUrl(publicUrl),
    };
  }

  if (provider === 'custom') {
    const command = await input({
      message: 'Tunnel command (use {port} where mvmt should insert the local port)',
      validate: (value) => (value.trim().length > 0 ? true : 'Enter a tunnel command'),
    });
    const publicUrl = await input({
      message: 'Public base URL (optional, recommended if the command does not print one)',
      default: '',
      validate: (value) => (value.trim().length === 0 ? true : validatePublicUrlInput(value)),
    });
    return {
      provider: 'custom',
      command: command.trim(),
      ...(publicUrl.trim().length > 0 ? { url: normalizeTunnelBaseUrl(publicUrl) } : {}),
    };
  }

  return {
    provider,
    command: defaultTunnelCommand(provider),
  };
}

function validatePublicUrlInput(value: string): true | string {
  try {
    const url = new URL(normalizeTunnelBaseUrl(value));
    return url.protocol === 'https:' ? true : 'Enter an https:// URL';
  } catch {
    return 'Enter a valid public URL, for example https://pnee.gofrieda.org';
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

function printBanner(): void {
  console.log(`\n${chalk.bold('mvmt')} - local MCP hub\n`);
}

function printAvailableConnectors(vaults: string[], memPalace: DetectedMemPalace): void {
  console.log('Available connectors:');
  console.log('  - Filesystem manual folder access');
  console.log(
    `  - Obsidian ${chalk.dim(
      vaults.length > 0
        ? `detected ${vaults.length} vault${vaults.length === 1 ? '' : 's'}`
        : 'no vault auto-detected; manual path supported',
    )}`,
  );
  const memPalaceStatus =
    memPalace.command && memPalace.palacePath
      ? 'detected MCP command and palace path'
      : memPalace.command
        ? 'detected MCP command; palace path required'
        : memPalace.palacePath
          ? 'detected palace path; MCP command required'
          : 'not detected; manual path and command supported';
  console.log(`  - MemPalace ${chalk.dim(memPalaceStatus)}`);
  console.log('');
}
