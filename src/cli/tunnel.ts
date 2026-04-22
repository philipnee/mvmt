import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';
import { configExists, expandHome, getConfigPath, readConfig, resolveConfigPath } from '../config/loader.js';
import { MvmtConfig, TunnelConfig } from '../config/schema.js';
import {
  cloudflareNamedTunnelCommand,
  defaultTunnelCommand,
  formatMcpPublicUrl,
  missingTunnelDependency,
  normalizeTunnelBaseUrl,
} from '../utils/tunnel.js';
import {
  ControlUnavailableError,
  getControlSocketPath,
  sendJsonControlRequest,
  streamJsonControl,
} from '../utils/control.js';

export interface TunnelCommandOptions {
  config?: string;
}

export interface TunnelRuntimeStatus {
  configured: boolean;
  running: boolean;
  command?: string;
  publicUrl?: string;
  recentLogs?: string[];
}

export async function showTunnel(options: TunnelCommandOptions = {}): Promise<void> {
  const loaded = loadConfigSummary(options.config);
  if (!loaded) return;

  const runtime = await readRuntimeStatus(loaded.configPath);
  printTunnelSummary(loaded.config, runtime);
}

export async function configureTunnel(options: TunnelCommandOptions = {}): Promise<void> {
  const loaded = loadConfigSummary(options.config);
  if (!loaded) return;

  const tunnel = await promptForTunnelConfig(loaded.config.server.port);
  loaded.config.server.access = 'tunnel';
  loaded.config.server.tunnel = tunnel;
  await saveConfig(loaded.configPath, loaded.config);

  console.log(chalk.green(`Tunnel config saved to ${loaded.configPath}`));

  try {
    const runtime = await sendJsonControlRequest<TunnelRuntimeStatus>(getControlSocketPath(loaded.configPath), {
      type: 'tunnel.config',
      tunnel,
    });
    if (runtime.publicUrl) {
      console.log(`public URL  ${chalk.yellow(formatMcpPublicUrl(runtime.publicUrl))}`);
    } else {
      console.log(chalk.dim('Tunnel config applied. mvmt is still running locally.'));
    }
  } catch (err) {
    if (err instanceof ControlUnavailableError) {
      console.log(chalk.dim('Config saved. Start mvmt with `mvmt serve` to launch the tunnel.'));
      return;
    }
    throw err;
  }
}

export async function startTunnelCommand(options: TunnelCommandOptions = {}): Promise<void> {
  const runtime = await sendTunnelRequest(options.config, 'tunnel.start');
  printTunnelActionResult(runtime);
}

export async function refreshTunnelCommand(options: TunnelCommandOptions = {}): Promise<void> {
  const runtime = await sendTunnelRequest(options.config, 'tunnel.refresh');
  printTunnelActionResult(runtime);
}

export async function stopTunnelCommand(options: TunnelCommandOptions = {}): Promise<void> {
  const runtime = await sendTunnelRequest(options.config, 'tunnel.stop');
  if (!runtime.running) {
    console.log(chalk.dim('Tunnel stopped. mvmt is still serving locally.'));
    return;
  }
  printTunnelActionResult(runtime);
}

export async function showTunnelLogs(options: TunnelCommandOptions = {}): Promise<void> {
  const runtime = await sendTunnelRequest(options.config, 'tunnel.logs');
  const logs = runtime.recentLogs ?? [];
  console.log('mvmt tunnel logs\n');
  if (logs.length === 0) {
    console.log(chalk.dim('No tunnel output captured.'));
    return;
  }

  for (const line of logs.slice(-20)) {
    console.log(line);
  }
}

export async function streamTunnelLogs(options: TunnelCommandOptions = {}): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  const socketPath = getControlSocketPath(configPath);
  const stop = await streamJsonControl(socketPath, { type: 'tunnel.logs.stream' }, (message) => {
    if (message?.kind === 'ready') {
      console.log(chalk.dim('Streaming tunnel logs. Press Ctrl+C to stop.'));
      for (const line of message.logs ?? []) {
        console.log(line);
      }
      return;
    }
    if (message?.kind === 'log' && typeof message.line === 'string') {
      console.log(message.line);
      return;
    }
    if (message?.kind === 'error') {
      console.error(message.error ?? 'Tunnel log stream failed.');
    }
  });

  await new Promise<void>((resolve) => {
    const handleSigint = () => {
      process.off('SIGINT', handleSigint);
      stop();
      resolve();
    };
    process.on('SIGINT', handleSigint);
  });
}

export function printTunnelSummary(config: MvmtConfig, runtime?: TunnelRuntimeStatus): void {
  console.log('mvmt tunnel\n');
  console.log('Configured');
  console.log(`  access: ${config.server.access}`);
  if (config.server.access !== 'tunnel' || !config.server.tunnel) {
    console.log(`  ${chalk.dim('Tunnel is not configured.')}`);
    return;
  }

  console.log(`  provider: ${config.server.tunnel.provider}`);
  console.log(`  command: ${config.server.tunnel.command}`);
  if (config.server.tunnel.url) {
    console.log(`  public URL: ${formatMcpPublicUrl(config.server.tunnel.url)}`);
  }

  console.log('\nLive');
  if (!runtime) {
    console.log(`  ${chalk.dim('mvmt is not running.')}`);
    return;
  }
  console.log(`  status: ${runtime.running ? 'running' : 'stopped'}`);
  if (runtime.command) console.log(`  command: ${runtime.command}`);
  if (runtime.publicUrl) console.log(`  public URL: ${formatMcpPublicUrl(runtime.publicUrl)}`);
}

export async function promptForTunnelConfig(port: number): Promise<TunnelConfig> {
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
      printMissingTunnelDependencyWarning(missingDependency, (line) => console.log(chalk.yellow(line)));
      console.log(chalk.dim('Choose another tunnel provider, or press Ctrl+C and install the missing command first.'));
      continue;
    }
    if (!tunnel.command.includes('{port}') && provider !== 'cloudflare-named') {
      console.log(chalk.yellow(`The configured tunnel command does not include ${chalk.cyan('{port}')}.`));
      console.log(chalk.dim(`mvmt expects tunnel commands to reference the local port ${port}.`));
    }
    return tunnel;
  }
}

export function printMissingTunnelDependencyWarning(command: string, write: (line: string) => void): void {
  if (command === 'cloudflared') {
    write('Cloudflare Quick Tunnel requires `cloudflared`, but it is not installed or not on PATH.');
    write('Install it with `brew install cloudflared`, or run `mvmt tunnel config` and choose another provider.');
    return;
  }
  write(`Tunnel dependency is missing: ${command}`);
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
        const resolved = expandHome(value.trim());
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
      command: cloudflareNamedTunnelCommand(expandHome(configPath.trim())),
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

function loadConfigSummary(configOverride?: string): { configPath: string; config: MvmtConfig } | undefined {
  const configPath = resolveConfigPath(configOverride);
  if (!configExists(configPath)) {
    console.error(`Config not found at ${configPath}`);
    console.error('Run `mvmt config setup` to create one.');
    process.exitCode = 1;
    return undefined;
  }

  try {
    return { configPath, config: readConfig(configPath) };
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Invalid config.');
    process.exitCode = 1;
    return undefined;
  }
}

async function readRuntimeStatus(configPath: string): Promise<TunnelRuntimeStatus | undefined> {
  try {
    return await sendJsonControlRequest<TunnelRuntimeStatus>(getControlSocketPath(configPath), { type: 'tunnel.status' });
  } catch (err) {
    if (err instanceof ControlUnavailableError) return undefined;
    throw err;
  }
}

async function sendTunnelRequest(configOverride: string | undefined, type: string): Promise<TunnelRuntimeStatus> {
  const configPath = resolveConfigPath(configOverride);
  try {
    return await sendJsonControlRequest<TunnelRuntimeStatus>(getControlSocketPath(configPath), { type });
  } catch (err) {
    if (err instanceof ControlUnavailableError) {
      console.error('mvmt is not running. Start it first with `mvmt serve`.');
      process.exitCode = 1;
      return {
        configured: false,
        running: false,
      };
    }
    throw err;
  }
}

function printTunnelActionResult(runtime: TunnelRuntimeStatus): void {
  if (runtime.publicUrl) {
    console.log(`public URL  ${chalk.yellow(formatMcpPublicUrl(runtime.publicUrl))}`);
    return;
  }

  if (!runtime.configured) {
    console.log(chalk.yellow('No tunnel is configured. Run `mvmt tunnel config` first.'));
    return;
  }

  if (!runtime.running) {
    console.log(chalk.dim('Tunnel is configured but not running.'));
    return;
  }

  console.log(chalk.dim('Tunnel is running, but no public URL has been detected yet.'));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function validatePublicUrlInput(value: string): true | string {
  try {
    const url = new URL(normalizeTunnelBaseUrl(value));
    return url.protocol === 'https:' ? true : 'Enter an https:// URL';
  } catch {
    return 'Enter a valid public URL, for example https://pnee.gofrieda.org';
  }
}

async function saveConfig(configPath: string, config: MvmtConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml.stringify(config), 'utf-8');
  if (process.platform !== 'win32') {
    await fs.chmod(configPath, 0o600);
  }
}
