import readline from 'node:readline';
import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { configExists, loadConfig, resolveConfigPath } from '../config/loader.js';
import { MvmtConfig, TunnelConfig } from '../config/schema.js';
import { Connector } from '../connectors/types.js';
import { ObsidianConnector } from '../connectors/obsidian.js';
import { createProxyConnector } from '../connectors/factory.js';
import { createTemporaryFilesystemConfig, printConfigSummary, readFilesystemPaths } from './config.js';
import { setupConfig } from './init.js';
import { createPlugins } from '../plugins/factory.js';
import { ToolResultPlugin } from '../plugins/types.js';
import { HttpRequestLogEntry, startHttpServer, startStdioServer } from '../server/index.js';
import { ToolRouter } from '../server/router.js';
import { AUDIT_LOG_PATH, AuditEntry, AuditLogger, createAuditLogger } from '../utils/audit.js';
import { getControlSocketPath, startJsonControlServer } from '../utils/control.js';
import { createLogger, Logger } from '../utils/logger.js';
import { defaultSigningKeyPath, generateSessionToken, rotateSigningKey, TOKEN_PATH, verifySessionTokenValue } from '../utils/token.js';
import {
  formatMcpPublicUrl,
  missingTunnelDependency,
  RunningTunnel,
  startTunnel,
} from '../utils/tunnel.js';
import { printTokenSummary, readTokenSummary } from './token.js';
import { printMissingTunnelDependencyWarning, promptForTunnelConfig } from './tunnel.js';

export interface StartOptions {
  port?: string;
  config?: string;
  path?: string[];
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

  const savedConfigPath = resolveConfigPath(options.config);
  let configPath = savedConfigPath;
  const requestedPaths = options.path ?? [];
  const temporaryCleanupTasks: CleanupTask[] = [];
  if (requestedPaths.length > 0) {
    try {
      const temporaryConfig = await createTemporaryFilesystemConfig({
        paths: requestedPaths,
        port: parsePort(options.port),
      });
      configPath = temporaryConfig.configPath;
      temporaryCleanupTasks.push(temporaryConfig.cleanup);
      logger.info('Using a temporary read-only filesystem config for this run only.');
      logger.info(`Saved config at ${savedConfigPath} was not modified.`);
      logger.info('Serving folders:');
      for (const folder of readFilesystemPaths(temporaryConfig.config.proxy[0])) {
        logger.info(`  ${folder}`);
      }
    } catch (err) {
      logger.error(err instanceof Error ? err.message : 'Failed to update filesystem access.');
      process.exit(1);
    }
  }

  if (!configExists(configPath)) {
    if (stdioMode) {
      logger.error(`Config not found at ${configPath}`);
      logger.error('Run `mvmt config setup` or `mvmt serve --path <dir>` first.');
      process.exit(1);
    }

    await setupConfig({
      config: configPath,
      promptOnOverwrite: false,
      printNextStep: false,
    });
  }
  const config = loadConfig(configPath);
  const port = parsePort(options.port) ?? config.server.port;
  const loaded = await initializeConnectors(config, stdioMode, logger);
  const plugins = createPlugins(config.plugins);
  for (const plugin of plugins) {
    emit(`Loaded plugin:${plugin.id}`, stdioMode, logger);
  }

  if (loaded.length === 0) {
    emit('No connectors loaded. Nothing to serve.', stdioMode, logger, 'error');
    emit('Check your config with `mvmt config` or rerun `mvmt config setup`.', stdioMode, logger, 'error');
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
  const cleanupTasks: CleanupTask[] = [...temporaryCleanupTasks, ...loaded.map((entry) => () => entry.connector.shutdown())];
  const shutdown = registerShutdown(cleanupTasks, stdioMode, logger);

  if (stdioMode) {
    const stdio = await startStdioServer(router);
    cleanupTasks.push(() => stdio.close());
    return;
  }

  try {
    const tunnelController = new TunnelController(config.server, port, logger);
    const httpServer = await startHttpServer(router, {
      port,
      allowedOrigins: config.server.allowedOrigins,
      resolvePublicBaseUrl: () => tunnelController.publicUrl,
      requestLog: interactiveMode
        ? (entry) => (audit as InteractiveAuditLogger).recordHttp(entry)
        : options.verbose
          ? (entry) => logger.debug(formatHttpRequestEntry(entry))
          : undefined,
    });
    cleanupTasks.push(() => httpServer.close());
    cleanupTasks.push(() => tunnelController.stop());
    const tunnel = await tunnelController.start();
    const controlServer = await startJsonControlServer(getControlSocketPath(configPath), async (message, connection) => {
      switch (message?.type) {
        case 'tunnel.status':
          connection.send({ ok: true, result: tunnelController.snapshot() });
          connection.close();
          return;
        case 'tunnel.start':
          await tunnelController.start();
          connection.send({ ok: true, result: tunnelController.snapshot() });
          connection.close();
          return;
        case 'tunnel.refresh':
          await tunnelController.refresh();
          connection.send({ ok: true, result: tunnelController.snapshot() });
          connection.close();
          return;
        case 'tunnel.stop':
          await tunnelController.stop();
          connection.send({ ok: true, result: tunnelController.snapshot() });
          connection.close();
          return;
        case 'tunnel.logs':
          connection.send({ ok: true, result: tunnelController.snapshot() });
          connection.close();
          return;
        case 'tunnel.config': {
          if (!message.tunnel || typeof message.tunnel !== 'object') {
            connection.send({ ok: false, error: 'Missing tunnel config' });
            connection.close();
            return;
          }
          const tunnelConfig = message.tunnel as TunnelConfig;
          config.server.access = 'tunnel';
          config.server.tunnel = tunnelConfig;
          await saveRuntimeConfig(configPath, config);
          await tunnelController.stop();
          tunnelController.configure(tunnelConfig);
          await tunnelController.start();
          connection.send({ ok: true, result: tunnelController.snapshot() });
          connection.close();
          return;
        }
        case 'tunnel.logs.stream': {
          connection.send({ kind: 'ready', logs: tunnelController.recentLogs() });
          const unsubscribe = tunnelController.subscribeLogs((line) => {
            connection.send({ kind: 'log', line });
          });
          connection.onClose(unsubscribe);
          return;
        }
        default:
          connection.send({ ok: false, error: `Unknown control request: ${String(message?.type ?? '(missing)')}` });
          connection.close();
      }
    }, {
      verifyToken: (token) => verifySessionTokenValue(token),
    });
    cleanupTasks.push(() => controlServer.close());
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
      logger.error(`Try: mvmt serve --port ${port + 1}`);
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
  private readonly listeners = new Set<(line: string) => void>();
  private lastError: string | undefined;

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
    this.lastError = undefined;
  }

  recentLogs(): string[] {
    return [...this.logs];
  }

  snapshot(): {
    configured: boolean;
    running: boolean;
    command?: string;
    publicUrl?: string;
    recentLogs: string[];
    lastError?: string;
  } {
    return {
      configured: this.configured,
      running: this.running,
      command: this.command,
      publicUrl: this.publicUrl,
      recentLogs: this.recentLogs(),
      lastError: this.lastError,
    };
  }

  subscribeLogs(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
      this.lastError = `${missingDependency}: command not found`;
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
      this.lastError = undefined;
      if (!tunnel.url) {
        this.logger.warn('Tunnel process started, but mvmt could not detect a public URL from its output yet.');
        return tunnel;
      }
      this.logger.info(`Tunnel URL: ${formatMcpPublicUrl(tunnel.url)}`);
      return tunnel;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Unknown error';
      this.logger.warn(`Tunnel failed to start: ${this.lastError}`);
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
    for (const listener of this.listeners) {
      listener(line);
    }
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
    console.log(`${chalk.bold('Token')}        type ${chalk.cyan('token')} to print the bearer token`);
    console.log(`${chalk.bold('Tool-call log')} ${AUDIT_LOG_PATH}`);
    console.log(`${chalk.bold('Live events')}   OAuth, MCP auth, and tool-call attempts`);
    console.log(`\n${chalk.dim('Interactive mode: type "help" for commands.')}`);
  } else {
    console.log(`${chalk.bold('Token')}        ${TOKEN_PATH}`);
    console.log(`${chalk.bold('Tool-call log')} ${AUDIT_LOG_PATH}`);
    console.log('\nRead token with:');
    console.log(`  ${chalk.cyan('mvmt token')}\n`);
    console.log('Connect from Claude Desktop:');
    console.log(`  { "mcpServers": { "mvmt": { "url": "http://127.0.0.1:${port}/mcp", "headers": { "Authorization": "Bearer <token from mvmt token>" } } } }`);
    console.log('\nOr via Claude Code:');
    console.log(`  ${chalk.cyan(`claude mcp add --transport http --header "Authorization: Bearer <token from mvmt token>" mvmt http://127.0.0.1:${port}/mcp`)}\n`);
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

  recordHttp(entry: HttpRequestLogEntry): void {
    if (this.liveLogs && this.writer) {
      this.writer(formatHttpRequestEntry(entry));
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
    case 'config':
      printConfigSummary(state.config, state.configPath, {
        tunnel: state.tunnel.snapshot(),
      });
      return;
    case 'config setup':
      console.log(chalk.dim('Run `mvmt config setup` in another shell, then restart `mvmt serve` to apply the new config.'));
      return;
    case 'token':
      printTokenSummary(readTokenSummary());
      return;
    case 'token show':
      printCurrentTokenValue();
      return;
    case 'token rotate':
      printRotatedToken();
      return;
    case 'logs':
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
    case 'tunnel logs stream':
      console.log(chalk.dim('Use `mvmt tunnel logs stream` from another shell to follow tunnel output continuously.'));
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
  console.log('  config              show saved mvmt config');
  console.log('  config setup        rerun guided setup in another shell');
  console.log('  token               show current bearer token and age');
  console.log('  token rotate        generate and print a new bearer token');
  console.log('  tunnel              show tunnel status');
  console.log('  tunnel config       choose a different tunnel');
  console.log('  tunnel start        start the configured tunnel');
  console.log('  tunnel refresh      restart the tunnel and print the new URL');
  console.log('  tunnel stop         stop public tunnel exposure');
  console.log('  tunnel logs         show recent tunnel output');
  console.log('  tunnel logs stream  stream tunnel output from another shell');
  console.log('  logs                show live request/tool log state');
  console.log('  logs on/off         toggle live request/tool logs');
  console.log('  status      show server, connector, token, and log status');
  console.log('  url         show local and public MCP URLs');
  console.log('  connectors  list loaded connectors');
  console.log('  clear       clear the terminal');
  console.log('  quit        stop mvmt');
  console.log('');
}

function printLiveLogState(state: InteractivePromptState): void {
  console.log(`live logs: ${state.audit.getLiveLogs() ? chalk.green('on') : chalk.dim('off')}`);
}

function printCurrentTokenValue(): void {
  const summary = readTokenSummary();
  if (!summary.token) {
    console.log(chalk.red(`No session token found at ${TOKEN_PATH}`));
    return;
  }
  console.log(summary.token);
}

function printRotatedToken(): void {
  const token = generateSessionToken();
  rotateSigningKey(defaultSigningKeyPath(TOKEN_PATH));
  console.log(token);
  console.log(chalk.yellow('Token rotated. Restart mvmt so OAuth clients re-authorize with the new signing key.'));
}

function printInteractiveStatus(state: InteractivePromptState): void {
  console.log('');
  console.log(chalk.bold('Status'));
  printInteractiveUrls(state);
  console.log(`token command  ${chalk.cyan('token')}`);
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
    console.log(chalk.yellow('No tunnel is configured. Run `tunnel config` or `mvmt tunnel config`.'));
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
    console.log(chalk.yellow('No tunnel is configured. Run `tunnel config` or `mvmt tunnel config`.'));
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

async function saveRuntimeConfig(configPath: string, config: MvmtConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml.stringify(config), 'utf-8');
  if (process.platform !== 'win32') {
    await fs.chmod(configPath, 0o600);
  }
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

function formatHttpRequestEntry(entry: HttpRequestLogEntry): string {
  const status =
    entry.status >= 500
      ? chalk.red(String(entry.status))
      : entry.status >= 400
        ? chalk.yellow(String(entry.status))
        : chalk.green(String(entry.status));
  const time = chalk.dim(new Date(entry.ts).toLocaleTimeString());
  const client = entry.clientId ? chalk.dim(` client=${entry.clientId}`) : '';
  const detail = entry.detail ? chalk.dim(` ${entry.detail}`) : '';
  return `${time} ${status} ${chalk.magenta(entry.kind)} ${entry.method} ${entry.path}${client}${detail}`;
}
