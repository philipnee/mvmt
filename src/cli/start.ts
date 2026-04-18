import readline from 'node:readline';
import chalk from 'chalk';
import { loadConfig } from '../config/loader.js';
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
import { formatMcpPublicUrl, RunningTunnel, startTunnel } from '../utils/tunnel.js';

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

  const config = loadConfig(options.config);
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

  const cleanupTasks: CleanupTask[] = loaded.map((entry) => () => entry.connector.shutdown());
  const shutdown = registerShutdown(cleanupTasks, stdioMode, logger);

  if (stdioMode) {
    await startStdioServer(router);
    return;
  }

  try {
    await startHttpServer(router, {
      port,
      allowedOrigins: config.server.allowedOrigins,
    });
    const tunnel = await maybeStartTunnel(config.server, port, logger);
    if (tunnel) cleanupTasks.push(() => tunnel.stop());
    printStartupBanner(port, loaded, plugins, router.getAllTools().length, tunnel?.url, interactiveMode);
    if (interactiveMode) {
      startInteractivePrompt({
        port,
        publicUrl: tunnel?.url,
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
    process.exit(1);
  }
}

async function maybeStartTunnel(
  serverConfig: ReturnType<typeof loadConfig>['server'],
  port: number,
  logger: Logger,
): Promise<RunningTunnel | undefined> {
  if (serverConfig.access !== 'tunnel') return undefined;

  if (!serverConfig.tunnel) {
    logger.warn('Tunnel access is enabled, but no tunnel command is configured.');
    return undefined;
  }

  logger.info(`Starting tunnel: ${serverConfig.tunnel.command.replaceAll('{port}', String(port))}`);
  try {
    const tunnel = await startTunnel(serverConfig.tunnel.command, port);
    tunnel.url = tunnel.url || serverConfig.tunnel.url;
    if (!tunnel.url) {
      logger.warn('Tunnel process started, but mvmt could not detect a public URL from its output yet.');
      return tunnel;
    }
    logger.info(`Tunnel URL: ${formatMcpPublicUrl(tunnel.url)}`);
    return tunnel;
  } catch (err) {
    logger.warn(`Tunnel failed to start: ${err instanceof Error ? err.message : 'Unknown error'}`);
    logger.warn('mvmt is still running locally.');
    return undefined;
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
    await Promise.all(cleanupTasks.map((task) => task().catch(() => undefined)));
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
  console.log(`${chalk.bold('mvmt running')} -> ${chalk.cyan(`http://localhost:${port}/mcp`)}`);
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
  console.log(`${chalk.bold('Token')}    ${TOKEN_PATH}`);
  console.log(`${chalk.bold('Audit')}    ${AUDIT_LOG_PATH}`);
  if (interactiveMode) {
    console.log(`\n${chalk.dim('Interactive mode: type "help" for commands.')}`);
  } else {
    console.log('\nRead token with:');
    console.log(`  ${chalk.cyan('mvmt token show')}\n`);
    console.log('Connect from Claude Desktop:');
    console.log(`  { "mcpServers": { "mvmt": { "url": "http://localhost:${port}/mcp", "headers": { "Authorization": "Bearer <token from mvmt token show>" } } } }`);
    console.log('\nOr via Claude Code:');
    console.log(`  ${chalk.cyan(`claude mcp add --transport http --header "Authorization: Bearer $(mvmt token show)" mvmt http://localhost:${port}/mcp`)}\n`);
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
  port: number;
  publicUrl?: string;
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
    if (command !== 'quit' && command !== 'exit') rl.prompt();
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
  switch (command) {
    case '':
      return;
    case 'help':
    case '?':
      printInteractiveHelp();
      return;
    case 'token':
    case 'show token':
    case 'token show':
      printCurrentToken();
      return;
    case 'rotate':
    case 'rotate token':
    case 'token rotate':
      printRotatedToken();
      return;
    case 'logs':
      console.log(`live logs: ${state.audit.getLiveLogs() ? chalk.green('on') : chalk.dim('off')}`);
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
    case 'connectors':
      printConnectorSummary(state.loaded, state.totalTools);
      return;
    case 'clear':
      console.clear();
      return;
    case 'quit':
    case 'exit':
      rl.close();
      return;
    default:
      console.log(chalk.yellow(`Unknown command: ${command}`));
      console.log(chalk.dim('Type "help" for commands.'));
  }
}

function printInteractiveHelp(): void {
  console.log('');
  console.log(chalk.bold('Commands'));
  console.log('  show token      print current bearer token');
  console.log('  rotate token    generate and print a new bearer token');
  console.log('  logs            show live log state');
  console.log('  logs on/off     toggle live tool-call logs');
  console.log('  status          show server, connector, token, and audit status');
  console.log('  url             show local and public MCP URLs');
  console.log('  connectors      list loaded connectors');
  console.log('  clear           clear the terminal');
  console.log('  quit            stop mvmt');
  console.log('');
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
  console.log(`token       ${TOKEN_PATH}`);
  console.log(`audit       ${AUDIT_LOG_PATH}`);
  console.log(`live logs   ${state.audit.getLiveLogs() ? chalk.green('on') : chalk.dim('off')}`);
  printPluginSummary(state.plugins);
  printConnectorSummary(state.loaded, state.totalTools);
}

function printInteractiveUrls(state: InteractivePromptState): void {
  console.log(`local URL   ${chalk.cyan(`http://localhost:${state.port}/mcp`)}`);
  if (state.publicUrl) {
    console.log(`public URL  ${chalk.yellow(formatMcpPublicUrl(state.publicUrl))}`);
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
