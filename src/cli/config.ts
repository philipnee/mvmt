import chalk from 'chalk';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { MvmtConfig, ProxyConfig } from '../config/schema.js';
import { configExists, expandHome, readConfig, resolveConfigPath, saveConfig } from '../config/loader.js';
import { filesystemSetupDefinition } from '../connectors/filesystem-setup.js';
import { buildConfig, SetupConfigOptions, setupConfig } from './init.js';
import { formatMcpPublicUrl } from '../utils/tunnel.js';

export interface ConfigCommandOptions {
  config?: string;
}

export interface TemporaryFilesystemConfigOptions {
  paths: string[];
  port?: number;
}

export interface TemporaryFilesystemConfig {
  config: MvmtConfig;
  configPath: string;
  cleanup(): Promise<void>;
}

export interface ConfigSummaryRuntime {
  tunnel?: {
    configured: boolean;
    running: boolean;
    command?: string;
    publicUrl?: string;
  };
}

export async function runConfigSetup(options: SetupConfigOptions = {}): Promise<void> {
  await setupConfig({
    ...options,
    promptOnOverwrite: options.promptOnOverwrite ?? true,
    printNextStep: options.printNextStep ?? true,
  });
}

export async function showConfig(options: ConfigCommandOptions = {}): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  if (!configExists(configPath)) {
    console.error(`Config not found at ${configPath}`);
    console.error('Run `mvmt config setup` to create one.');
    process.exitCode = 1;
    return;
  }

  try {
    const config = readConfig(configPath);
    printConfigSummary(config, configPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Invalid config.');
    process.exitCode = 1;
  }
}

export async function createTemporaryFilesystemConfig(
  options: TemporaryFilesystemConfigOptions,
): Promise<TemporaryFilesystemConfig> {
  const normalizedPaths = Array.from(new Set(options.paths.map((entry) => path.resolve(expandHome(entry)))));
  if (normalizedPaths.length === 0) {
    throw new Error('At least one folder is required for `mvmt serve --path`.');
  }

  const base = buildConfig({ port: options.port ?? 4141 });
  const config = filesystemSetupDefinition.apply(base, {
    paths: normalizedPaths,
    writeAccess: false,
  });
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'mvmt-serve-'));
  const configPath = path.join(tempDir, 'config.yaml');
  await saveConfig(configPath, config);

  return {
    config,
    configPath,
    async cleanup() {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    },
  };
}

export function printConfigSummary(
  config: MvmtConfig,
  configPath: string,
  runtime?: ConfigSummaryRuntime,
): void {
  console.log('mvmt config\n');
  console.log('Config');
  console.log(`  path: ${configPath}`);

  console.log('\nServer');
  console.log(`  port: ${config.server.port}`);
  console.log(`  local URL: http://127.0.0.1:${config.server.port}/mcp`);
  console.log(`  access: ${config.server.access}`);

  if (config.server.access === 'tunnel') {
    const tunnelStatus = runtime?.tunnel;
    const tunnel = config.server.tunnel;
    console.log(`  provider: ${tunnel?.provider ?? 'custom'}`);
    if (tunnelStatus) {
      console.log(`  tunnel: ${tunnelStatus.running ? 'running' : 'stopped'}`);
    }
    if (tunnelStatus?.command ?? tunnel?.command) {
      console.log(`  command: ${tunnelStatus?.command ?? tunnel?.command}`);
    }
    if (tunnelStatus?.publicUrl ?? tunnel?.url) {
      console.log(`  public URL: ${formatMcpPublicUrl(tunnelStatus?.publicUrl ?? tunnel?.url ?? '')}`);
    }
  }

  printFilesystemSummary(config.proxy);
  printObsidianSummary(config);
  printMemPalaceSummary(config.proxy);
  printPluginSummary(config);
}

function printFilesystemSummary(proxy: ProxyConfig[]): void {
  console.log('\nFilesystem');
  const filesystem = proxy.find((entry) => entry.name.toLowerCase() === 'filesystem' && entry.enabled !== false);
  if (!filesystem) {
    console.log(`  ${chalk.dim('not configured')}`);
    return;
  }

  const paths = readFilesystemPaths(filesystem);
  if (paths.length === 0) {
    console.log(`  ${chalk.dim('configured, but no folder paths were parsed')}`);
    return;
  }

  for (const folder of paths) {
    console.log(`  ${folder}  ${filesystem.writeAccess ? 'writable' : 'read-only'}`);
  }
}

function printObsidianSummary(config: MvmtConfig): void {
  console.log('\nObsidian');
  if (!config.obsidian?.enabled) {
    console.log(`  ${chalk.dim('not configured')}`);
    return;
  }
  console.log(`  path: ${config.obsidian.path}`);
  console.log(`  write access: ${config.obsidian.writeAccess ? 'yes' : 'no'}`);
}

function printMemPalaceSummary(proxy: ProxyConfig[]): void {
  console.log('\nMemPalace');
  const memPalace = proxy.find((entry) => entry.name.toLowerCase() === 'mempalace' && entry.enabled !== false);
  if (!memPalace) {
    console.log(`  ${chalk.dim('not configured')}`);
    return;
  }

  console.log(`  command: ${memPalace.command ?? '(missing)'}`);
  const palacePath = readArgValue(memPalace.args, '--palace');
  if (palacePath) console.log(`  palace: ${palacePath}`);
  console.log(`  write access: ${memPalace.writeAccess ? 'yes' : 'no'}`);
}

function printPluginSummary(config: MvmtConfig): void {
  console.log('\nPlugins');
  const enabled = config.plugins.filter((plugin) => plugin.enabled !== false);
  if (enabled.length === 0) {
    console.log(`  ${chalk.dim('none')}`);
    return;
  }

  for (const plugin of enabled) {
    console.log(`  ${plugin.name}`);
  }
}

export function readFilesystemPaths(proxy: ProxyConfig): string[] {
  if (!proxy.args || proxy.args.length === 0) return [];
  const packageIndex = proxy.args.findIndex((arg) => arg === '@modelcontextprotocol/server-filesystem');
  if (packageIndex === -1) return [];
  return proxy.args.slice(packageIndex + 1);
}

function readArgValue(args: string[] = [], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index === -1) return undefined;
  return args[index + 1];
}

