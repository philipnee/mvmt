import readline from 'node:readline';
import fs from 'fs/promises';
import path from 'path';
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import yaml from 'yaml';
import { expandHome, getConfigPath, loadConfig } from '../config/loader.js';
import { MvmtConfig, TunnelConfig } from '../config/schema.js';
import { Connector } from '../connectors/types.js';
import { ObsidianConnector } from '../connectors/obsidian.js';
import { createProxyConnector } from '../connectors/factory.js';
import { createPlugins } from '../plugins/factory.js';
import { ToolResultPlugin } from '../plugins/types.js';
import { startHttpServer, startStdioServer } from '../server/index.js';
import { ToolRouter } from '../server/router.js';
import { AUDIT_LOG_PATH, AuditEntry, AuditLogger, createAuditLogger } from '../utils/audit.js';
import { createLogger, Logger } from '../utils/logger.js';
import { generateSessionToken, readSessionToken, TOKEN_PATH } from '../utils/token.js';
import {
  cloudflareNamedTunnelCommand,
  defaultTunnelCommand,
  formatMcpPublicUrl,
  missingTunnelDependency,
  normalizeTunnelBaseUrl,
  RunningTunnel,
  startTunnel,
} from '../utils/tunnel.js';

export interface StartOptions {
  port?: string;
  config?: string;
  stdio?: boolean;
  verbose?: boolean;
  interactive?: boolean;
}

type LoadedConnector = {
  connector: Connector;
  toolCount: number;
};

type CleanupTask = () => Promise<void>;

export async function start(options: StartOptions = {}): Promise<void> {
  const logger = createLogger(Boolean(options.verbose));
  const stdioMode = Boolean(options.stdio);
  const interactiveMode = Boolean(options.interactive);

  if (stdioMode && interactiveMode) {
    logger.error('Interactive mode is only available in HTTP mode. Remove --stdio or -i.');
    process.exit(1);
  }

  const configPath = options.config ? expandHome(options.config) : getConfigPath();
  const config = loadConfig(configPath);
  const port = parsePort(options.port) ?? config.server.port;
  const loaded = await initializeConnectors(config, stdioMode, logger);
  const plugins = createPlugins(config.plugins);
  for (const plugin of plugins) {
    emit(`Loaded plugin:${plugin.id}`, stdioMode, logger);
  }

  if (loaded.length === 0) {
    emit('No connectors loaded. Nothing to serve.', stdioMode, logger, 'error');
    emit('Check your config or run `mvmt init`.', stdioMode, logger, 'error');
    process.exit(1);
  }

  const audit = interactiveMode
    ? new InteractiveAuditLogger(createAuditLogger())
    : createAuditLogger();
  const router = new ToolRouter(loaded.map((entry) => entry.connector), audit, plugins);
  await router.initialize();

  // Cleanup tasks run on SIGINT/SIGTERM and on startup failure.
  // Tasks are appended as resources are acquired so only initialized
  // resources are cleaned up. See registerShutdown for the 5-second
  // force-exit timeout that guards against hung cleanup.
  const cleanupTasks: CleanupTask[] = loaded.map((entry) => () => entry.connector.shutdown());
  const shutdown = registerShutdown(cleanupTasks, stdioMode, logger);

  if (stdioMode) {
    const stdio = await startStdioServer(router);
    cleanupTasks.push(() => stdio.close());
    return;
  }

  try {
    const httpServer = await startHttpServer(router, {
      port,
      allowedOrigins: config.server.allowedOrigins,
    });
    cleanupTasks.push(() => httpServer.close());
    const tunnelController = new TunnelController(config.server, port, logger);
    cleanupTasks.push(() => tunnelController.stop());
    const tunnel = await tunnelController.start();
    printStartupBanner(port, loaded, plugins, router.getAllTools().length, tunnel?.url, interactiveMode);
    if (interactiveMode) {
      startInteractivePrompt({
        config,
        configPath,
        port,
        tunnel: tunnelController,
        loaded,
        plugins,
        totalTools: router.getAllTools().length,
        audit: audit as InteractiveAuditLogger,
        shutdown,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('EADDRINUSE')) {
      logger.error(`Port ${port} is already in use.`);
      logger.error(`Try: mvmt start --port ${port + 1}`);
    } else {
      logger.error(`Failed to start server: ${message}`);
    }
    // Shut down connectors that were already initialized (e.g. stdio
    // child processes) so they don't outlive the parent process.
    await Promise.all(cleanupTasks.map((task) => task().catch(() => undefined)));
    process.exit(1);
  }
}

class TunnelController {
  private current: RunningTunnel | undefined;
  private readonly logs: string[] = [];

  constructor(
    private readonly serverConfig: MvmtConfig['server'],
    private readonly port: number,
    private readonly logger: Logger,
  ) {}

  get configured(): boolean {
    return this.serverConfig.access === 'tunnel' && Boolean(this.serverConfig.tunnel);
  }

  get running(): boolean {
    return Boolean(this.current);
  }

  get publicUrl(): string | undefined {
    return this.current?.url;
  }

  get command(): string | undefined {
    return this.serverConfig.tunnel?.command.replaceAll('{port}', String(this.port));
  }

  configure(tunnel: TunnelConfig): void {
    this.serverConfig.access = 'tunnel';
    this.serverConfig.tunnel = tunnel;
    this.logs.length = 0;
  }

  recentLogs(): string[] {
    return [...this.logs];
  }

  async start(): Promise<RunningTunnel | undefined> {
    if (this.current) return this.current;

    if (this.serverConfig.access !== 'tunnel') return undefined;

    if (!this.serverConfig.tunnel) {
      this.logger.warn('Tunnel access is enabled, but no tunnel command is configured.');
      return undefined;
    }

    const missingDependency = missingTunnelDependency(this.serverConfig.tunnel);
    if (missingDependency) {
      this.addLog(`${missingDependency}: command not found`);
      printMissingTunnelDependencyWarning(missingDependency, (line) => this.logger.warn(line));
      return undefined;
    }

    this.logger.info(`Starting tunnel: ${this.command}`);
    try {
      const tunnel = await startTunnel(this.serverConfig.tunnel.command, this.port, {
        onOutput: (line) => this.addLog(line),
      });
      tunnel.url = tunnel.url || this.serverConfig.tunnel.url;
      this.current = tunnel;
      if (!tunnel.url) {
        this.logger.warn('Tunnel process started, but mvmt could not detect a public URL from its output yet.');
        return tunnel;
      }
      this.logger.info(`Tunnel URL: ${formatMcpPublicUrl(tunnel.url)}`);
      return tunnel;
    } catch (err) {
      this.logger.warn(`Tunnel failed to start: ${err instanceof Error ? err.message : 'Unknown error'}`);
      this.logger.warn('mvmt is still running locally.');
      return undefined;
    }
  }

  async refresh(): Promise<RunningTunnel | undefined> {
    await this.stop();
    return this.start();
  }

  async stop(): Promise<void> {
    if (!this.current) return;
    const tunnel = this.current;
    this.current = undefined;
    await tunnel.stop();
  }

  private addLog(line: string): void {
    this.logs.push(line);
    if (this.logs.length > 100) this.logs.shift();
  }
}

async function initializeConnectors(
  config: ReturnType<typeof loadConfig>,
  stdioMode: boolean,
  logger: Logger,
): Promise<LoadedConnector[]> {
  const loaded: LoadedConnector[] = [];

  for (const proxyConfig of config.proxy) {
    if (!proxyConfig.enabled) continue;

    const connector = createProxyConnector(proxyConfig);
    if (!connector) {
      emit(`Proxy connector "${proxyConfig.name}" has no command or url. Skipping.`, stdioMode, logger, 'warn');
      continue;
    }

    try {
      await connector.initialize();
      const toolCount = (await connector.listTools()).length;
      loaded.push({ connector, toolCount });
      emit(`Loaded proxy:${proxyConfig.name} (${toolCount} tools)`, stdioMode, logger);
    } catch (err) {
      emit(
        `Proxy connector "${proxyConfig.name}" failed to start: ${formatConnectorError(err)}`,
        stdioMode,
        logger,
        'warn',
      );
      emit('Skipping proxy. Other connectors are still available.', stdioMode, logger, 'warn');
    }
  }

  if (config.obsidian?.enabled) {
    const connector = new ObsidianConnector(config.obsidian);
    try {
      await connector.initialize();
      const toolCount = (await connector.listTools()).length;
      loaded.push({ connector, toolCount });
      emit(`Loaded obsidian (${toolCount} tools)`, stdioMode, logger);
    } catch (err) {
      emit(
        `Native Obsidian connector failed to start: ${formatConnectorError(err)}`,
        stdioMode,
        logger,
        'warn',
      );
    }
  }

  return loaded;
}

// Runs all cleanup tasks on SIGINT/SIGTERM. If any task hangs (e.g. a
// child process that ignores SIGTERM), the 5-second force timer ensures
// the process still exits instead of hanging indefinitely.
function registerShutdown(
  cleanupTasks: CleanupTask[],
  stdioMode: boolean,
  logger: Logger,
): () => Promise<void> {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    emit('Shutting down...', stdioMode, logger);

    const forceTimer = setTimeout(() => {
      emit('Shutdown timed out, forcing exit.', stdioMode, logger, 'warn');
      process.exit(1);
    }, 5_000);
    forceTimer.unref();

    await Promise.all(cleanupTasks.map((task) => task().catch(() => undefined)));
    clearTimeout(forceTimer);
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return shutdown;
}

function printStartupBanner(
  port: number,
  loaded: LoadedConnector[],
  plugins: ToolResultPlugin[],
  totalTools: number,
  publicUrl?: string,
  interactiveMode = false,
): void {
  console.log('');
  console.log(chalk.cyan(MVMT_LOGO));
  console.log(`${chalk.bold('mvmt running')} -> ${chalk.cyan(`http://127.0.0.1:${port}/mcp`)}`);
  if (publicUrl) {
    console.log(`${chalk.bold('public URL  ')} -> ${chalk.yellow(formatMcpPublicUrl(publicUrl))}`);
  }
  console.log('');
  console.log(chalk.bold('Connectors:'));
  for (const entry of loaded) {
    console.log(`  ${chalk.green('ok')} ${entry.connector.id.padEnd(22)} ${String(entry.toolCount).padStart(3)} tools`);
  }
  console.log(`  ${chalk.dim('total'.padEnd(25))} ${String(totalTools).padStart(3)} tools\n`);
  if (plugins.length > 0) {
    console.log(chalk.bold('Plugins:'));
    for (const plugin of plugins) {
      console.log(`  ${chalk.green('ok')} ${plugin.id}`);
    }
    console.log('');
  }
  if (interactiveMode) {
    console.log(`${chalk.bold('Token')}        type ${chalk.cyan('token show')} to print the bearer token`);
    console.log(`${chalk.bold('Tool-call log')} ${AUDIT_LOG_PATH}`);
    console.log(`\n${chalk.dim('Interactive mode: type "help" for commands.')}`);
  } else {
    console.log(`${chalk.bold('Token')}        ${TOKEN_PATH}`);
    console.log(`${chalk.bold('Tool-call log')} ${AUDIT_LOG_PATH}`);
    console.log('\nRead token with:');
    console.log(`  ${chalk.cyan('mvmt show')}\n`);
    console.log('Connect from Claude Desktop:');
    console.log(`  { "mcpServers": { "mvmt": { "url": "http://127.0.0.1:${port}/mcp", "headers": { "Authorization": "Bearer <token from mvmt show>" } } } }`);
    console.log('\nOr via Claude Code:');
    console.log(`  ${chalk.cyan(`claude mcp add --transport http --header "Authorization: Bearer $(mvmt show)" mvmt http://127.0.0.1:${port}/mcp`)}\n`);
  }
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function emit(
  message: string,
  stdioMode: boolean,
  logger: Logger,
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  if (stdioMode) {
    process.stderr.write(`${message}\n`);
    return;
  }

  if (level === 'warn') logger.warn(message);
  else if (level === 'error') logger.error(message);
  else logger.info(message);
}

function formatConnectorError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Unknown error';

  try {
    const parsed = JSON.parse(message) as unknown;
    if (Array.isArray(parsed)) {
      const paths = parsed
        .map((issue) => {
          if (!issue || typeof issue !== 'object' || !Array.isArray((issue as { path?: unknown }).path)) {
            return undefined;
          }
          return (issue as { path: Array<string | number> }).path.join('.');
        })
        .filter((path): path is string => Boolean(path));

      if (paths.length > 0) {
        return `upstream server returned invalid MCP schema at ${paths.join(', ')}`;
      }
    }
  } catch {
    // Not a JSON-formatted validation error.
  }

  return message;
}

const MVMT_LOGO = String.raw`
 __  __ __     ____  __ _____
|  \/  |\ \   / /  \/  |_   _|
| |\/| | \ \ / /| |\/| | | |
| |  | |  \ V / | |  | | | |
|_|  |_|   \_/  |_|  |_| |_|
`;

class InteractiveAuditLogger implements AuditLogger {
  private liveLogs = true;
  private writer: ((message: string) => void) | undefined;

  constructor(private readonly inner: AuditLogger) {}

  record(entry: AuditEntry): void {
    this.inner.record(entry);
    if (this.liveLogs && this.writer) {
      this.writer(formatAuditEntry(entry));
    }
  }

  setLiveLogs(enabled: boolean): void {
    this.liveLogs = enabled;
  }

  getLiveLogs(): boolean {
    return this.liveLogs;
  }

  setWriter(writer: (message: string) => void): void {
    this.writer = writer;
  }
}

interface InteractivePromptState {
  config: MvmtConfig;
  configPath: string;
  port: number;
  tunnel: TunnelController;
  loaded: LoadedConnector[];
  plugins: ToolResultPlugin[];
  totalTools: number;
  audit: InteractiveAuditLogger;
  shutdown: () => Promise<void>;
}

function startInteractivePrompt(state: InteractivePromptState): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('> '),
  });

  const writeAbovePrompt = (message: string) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    console.log(message);
    rl.prompt(true);
  };

  state.audit.setWriter(writeAbovePrompt);
  rl.prompt();

  rl.on('line', async (line) => {
    const command = line.trim().toLowerCase();
    try {
      await handleInteractiveCommand(command, state, rl);
    } catch (err) {
      console.log(chalk.red(err instanceof Error ? err.message : 'Command failed'));
    }
    if (command !== 'quit' && command !== 'exit') {
      rl.prompt();
    }
  });

  rl.on('SIGINT', async () => {
    await state.shutdown();
  });

  rl.on('close', async () => {
    await state.shutdown();
  });
}

async function handleInteractiveCommand(
  command: string,
  state: InteractivePromptState,
  rl: readline.Interface,
): Promise<void> {
  if (command === 'quit' || command === 'exit') {
    rl.close();
    return;
  }

  if (command === 'clear') {
    console.clear();
    return;
  }

  if (command === 'help' || command === '?') {
    printInteractiveHelp();
    return;
  }

  switch (command) {
    case '':
      return;
    case 'token':
      printTokenHelp();
      return;
    case 'token show':
      printCurrentToken();
      return;
    case 'token rotate':
      printRotatedToken();
      return;
    case 'logs':
      printLogsHelp();
      return;
    case 'logs show':
      printLiveLogState(state);
      return;
    case 'logs on':
      state.audit.setLiveLogs(true);
      console.log(chalk.green('live logs on'));
      return;
    case 'logs off':
      state.audit.setLiveLogs(false);
      console.log(chalk.dim('live logs off'));
      return;
    case 'status':
      printInteractiveStatus(state);
      return;
    case 'url':
    case 'urls':
      printInteractiveUrls(state);
      return;
    case 'tunnel':
      printTunnelHelp();
      return;
    case 'tunnel show':
      printTunnelStatus(state);
      return;
    case 'tunnel config':
      await handleTunnelConfig(state);
      return;
    case 'tunnel start':
      await handleTunnelStart(state);
      return;
    case 'tunnel refresh':
      await handleTunnelRefresh(state);
      return;
    case 'tunnel stop':
      await handleTunnelStop(state);
      return;
    case 'tunnel logs':
      printTunnelLogs(state);
      return;
    case 'connectors':
      printConnectorSummary(state.loaded, state.totalTools);
      return;
    default:
      console.log(chalk.yellow(`Unknown command: ${command}`));
      console.log(chalk.dim('Type "help" for commands.'));
  }
}

function printInteractiveHelp(): void {
  console.log('');
  console.log(chalk.bold('Commands'));
  console.log('  token       show token commands');
  console.log('  tunnel      show tunnel commands');
  console.log('  logs        show live log commands');
  console.log('  status      show server, connector, token, and log status');
  console.log('  url         show local and public MCP URLs');
  console.log('  connectors  list loaded connectors');
  console.log('  clear       clear the terminal');
  console.log('  quit        stop mvmt');
  console.log('');
}

function printTokenHelp(): void {
  console.log('');
  console.log(chalk.bold('Token'));
  console.log('  token show      print current bearer token');
  console.log('  token rotate    generate and print a new bearer token');
  console.log('');
}

function printTunnelHelp(): void {
  console.log('');
  console.log(chalk.bold('Tunnel'));
  console.log('  tunnel show      show tunnel status');
  console.log('  tunnel config    choose a different tunnel');
  console.log('  tunnel start     start the configured tunnel');
  console.log('  tunnel refresh   restart the tunnel and print the new URL');
  console.log('  tunnel stop      stop public tunnel exposure');
  console.log('  tunnel logs      show recent tunnel output');
  console.log('');
}

function printLogsHelp(): void {
  console.log('');
  console.log(chalk.bold('Logs'));
  console.log('  logs show    show live log state');
  console.log('  logs on      turn live tool-call logs on');
  console.log('  logs off     turn live tool-call logs off');
  console.log('');
}

function printLiveLogState(state: InteractivePromptState): void {
  console.log(`live logs: ${state.audit.getLiveLogs() ? chalk.green('on') : chalk.dim('off')}`);
}

function printCurrentToken(): void {
  const token = readSessionToken();
  if (!token) {
    console.log(chalk.red(`No session token found at ${TOKEN_PATH}`));
    return;
  }
  console.log(token);
}

function printRotatedToken(): void {
  const token = generateSessionToken();
  console.log(token);
  console.log(chalk.yellow('Token rotated. Restart or update any clients using the old token.'));
}

function printInteractiveStatus(state: InteractivePromptState): void {
  console.log('');
  console.log(chalk.bold('Status'));
  printInteractiveUrls(state);
  console.log(`token command  ${chalk.cyan('token show')}`);
  console.log(`tool-call log  ${AUDIT_LOG_PATH}`);
  console.log(`live logs      ${state.audit.getLiveLogs() ? chalk.green('on') : chalk.dim('off')}`);
  printTunnelStatus(state);
  printPluginSummary(state.plugins);
  printConnectorSummary(state.loaded, state.totalTools);
}

function printInteractiveUrls(state: InteractivePromptState): void {
  console.log(`local URL   ${chalk.cyan(`http://127.0.0.1:${state.port}/mcp`)}`);
  if (state.tunnel.publicUrl) {
    console.log(`public URL  ${chalk.yellow(formatMcpPublicUrl(state.tunnel.publicUrl))}`);
  }
}

function printTunnelStatus(state: InteractivePromptState): void {
  console.log(chalk.bold('tunnel'));
  if (!state.tunnel.configured) {
    console.log(`  status      ${chalk.dim('not configured')}`);
    return;
  }
  console.log(`  status      ${state.tunnel.running ? chalk.green('running') : chalk.dim('stopped')}`);
  if (state.tunnel.command) console.log(`  command     ${chalk.dim(state.tunnel.command)}`);
  if (state.tunnel.publicUrl) {
    console.log(`  public URL  ${chalk.yellow(formatMcpPublicUrl(state.tunnel.publicUrl))}`);
  }
}

async function handleTunnelStart(state: InteractivePromptState): Promise<void> {
  if (!state.tunnel.configured) {
    console.log(chalk.yellow('No tunnel is configured. Run `tunnel config` or rerun `mvmt init`.'));
    return;
  }
  if (state.tunnel.running) {
    console.log(chalk.dim('Tunnel is already running.'));
    printTunnelStatus(state);
    return;
  }
  const tunnel = await state.tunnel.start();
  if (tunnel?.url) {
    console.log(`public URL  ${chalk.yellow(formatMcpPublicUrl(tunnel.url))}`);
  }
}

async function handleTunnelRefresh(state: InteractivePromptState): Promise<void> {
  if (!state.tunnel.configured) {
    console.log(chalk.yellow('No tunnel is configured. Run `tunnel config` or rerun `mvmt init`.'));
    return;
  }
  console.log('Refreshing tunnel...');
  const tunnel = await state.tunnel.refresh();
  if (tunnel?.url) {
    console.log(`public URL  ${chalk.yellow(formatMcpPublicUrl(tunnel.url))}`);
  } else {
    console.log(chalk.yellow('Tunnel refreshed, but no public URL was detected yet.'));
  }
}

async function handleTunnelConfig(state: InteractivePromptState): Promise<void> {
  const tunnel = await promptForTunnelConfig(state.port);
  const wasRunning = state.tunnel.running;

  if (wasRunning) {
    await state.tunnel.stop();
  }

  state.tunnel.configure(tunnel);
  state.config.server.access = 'tunnel';
  state.config.server.tunnel = tunnel;
  await saveRuntimeConfig(state.configPath, state.config);

  console.log(chalk.green(`Tunnel config saved to ${state.configPath}`));
  if (!wasRunning) {
    console.log(chalk.dim('Run `tunnel start` or `tunnel refresh` to launch it.'));
    return;
  }

  console.log('Restarting tunnel with new config...');
  const restarted = await state.tunnel.start();
  if (restarted?.url) {
    console.log(`public URL  ${chalk.yellow(formatMcpPublicUrl(restarted.url))}`);
  }
}

async function handleTunnelStop(state: InteractivePromptState): Promise<void> {
  if (!state.tunnel.running) {
    console.log(chalk.dim('Tunnel is not running.'));
    return;
  }
  await state.tunnel.stop();
  console.log(chalk.dim('Tunnel stopped.'));
}

function printTunnelLogs(state: InteractivePromptState): void {
  const logs = state.tunnel.recentLogs();
  console.log(chalk.bold('tunnel logs'));
  if (logs.length === 0) {
    console.log(`  ${chalk.dim('no tunnel output captured')}`);
    return;
  }
  for (const line of logs.slice(-20)) {
    console.log(`  ${line}`);
  }
}

async function promptForTunnelConfig(port: number): Promise<TunnelConfig> {
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
    return tunnel;
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

async function saveRuntimeConfig(configPath: string, config: MvmtConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml.stringify(config), 'utf-8');
  if (process.platform !== 'win32') {
    await fs.chmod(configPath, 0o600);
  }
}

function printMissingTunnelDependencyWarning(command: string, write: (line: string) => void): void {
  if (command === 'cloudflared') {
    write('Cloudflare Quick Tunnel requires `cloudflared`, but it is not installed or not on PATH.');
    write('Install it with `brew install cloudflared`, or run `tunnel config` and choose another provider.');
    return;
  }
  write(`Tunnel dependency is missing: ${command}`);
}

function printConnectorSummary(loaded: LoadedConnector[], totalTools: number): void {
  console.log(chalk.bold('connectors'));
  for (const entry of loaded) {
    console.log(`  ${chalk.green('ok')} ${entry.connector.id.padEnd(22)} ${String(entry.toolCount).padStart(3)} tools`);
  }
  console.log(`  ${chalk.dim('total'.padEnd(25))} ${String(totalTools).padStart(3)} tools`);
}

function printPluginSummary(plugins: ToolResultPlugin[]): void {
  console.log(chalk.bold('plugins'));
  if (plugins.length === 0) {
    console.log(`  ${chalk.dim('none')}`);
    return;
  }
  for (const plugin of plugins) {
    console.log(`  ${chalk.green('ok')} ${plugin.id}`);
  }
}

function formatAuditEntry(entry: AuditEntry): string {
  const status = entry.isError ? chalk.red('ERR') : chalk.green('OK ');
  const time = chalk.dim(new Date(entry.ts).toLocaleTimeString());
  const args = entry.argKeys.length > 0 ? chalk.dim(` args=${entry.argKeys.join(',')}`) : '';
  const redactions =
    entry.redactions && entry.redactions.length > 0
      ? chalk.yellow(
          ` redactions=${entry.redactions
            .map((item) => `${item.pattern}:${item.count}`)
            .join(',')}`,
        )
      : '';
  return `${time} ${status} ${chalk.cyan(entry.connectorId)} ${entry.tool}${args}${redactions} ${chalk.dim(`${entry.durationMs}ms`)}`;
}
