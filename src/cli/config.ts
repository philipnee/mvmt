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
  printMountSummary(config);
  printPluginSummary(config);
}

function printMountSummary(config: MvmtConfig): void {
  console.log('\nMounts');
  const mounts = config.mounts.filter((mount) => mount.enabled !== false);
  if (mounts.length === 0) {
    console.log(`  ${chalk.dim('not configured')}`);
    return;
  }

  for (const mount of mounts) {
    console.log(`  ${mount.name}: ${mount.path} -> ${mount.root}  ${mount.writeAccess ? 'writable' : 'read-only'}`);
    if (mount.description) console.log(`    description: ${mount.description}`);
    if (mount.guidance) console.log(`    guidance: ${mount.guidance}`);
  }
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
