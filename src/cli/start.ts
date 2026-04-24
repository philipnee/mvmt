import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { configExists, loadConfig, resolveConfigPath } from '../config/loader.js';
import { MvmtConfig, TunnelSchema } from '../config/schema.js';
import { createTemporaryFilesystemConfig, readFilesystemPaths } from './config.js';
import { setupConfig } from './init.js';
import { createPlugins } from '../plugins/factory.js';
import { ToolResultPlugin } from '../plugins/types.js';
import { startHttpServer, startStdioServer } from '../server/index.js';
import { ToolRouter } from '../server/router.js';
import { createAuditLogger, AUDIT_LOG_PATH } from '../utils/audit.js';
import { getControlSocketPath, startJsonControlServer } from '../utils/control.js';
import { createLogger, Logger } from '../utils/logger.js';
import { TOKEN_PATH, verifySessionTokenValue } from '../utils/token.js';
import { formatMcpPublicUrl } from '../utils/tunnel.js';
import { initializeConnectors, LoadedConnector } from './connector-loader.js';
import { TunnelController } from './tunnel-controller.js';
import { InteractiveAuditLogger, startInteractivePrompt, formatHttpRequestEntry } from './interactive.js';

export interface StartOptions {
  port?: string;
  config?: string;
  path?: string[];
  stdio?: boolean;
  verbose?: boolean;
  interactive?: boolean;
}

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
          const parsedTunnel = TunnelSchema.safeParse(message.tunnel);
          if (!parsedTunnel.success) {
            connection.send({ ok: false, error: 'Invalid tunnel config' });
            connection.close();
            return;
          }
          const tunnelConfig = parsedTunnel.data;
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
        persistConfig: () => saveRuntimeConfig(configPath, config),
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

async function saveRuntimeConfig(configPath: string, config: MvmtConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml.stringify(config), 'utf-8');
  if (process.platform !== 'win32') {
    await fs.chmod(configPath, 0o600);
  }
}

const MVMT_LOGO = String.raw`
 __  __ __     ____  __ _____
|  \/  |\ \   / /  \/  |_   _|
| |\/| | \ \ / /| |\/| | | |
| |  | |  \ V / | |  | | | |
|_|  |_|   \_/  |_|  |_| |_|
`;
