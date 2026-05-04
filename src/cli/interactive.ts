import readline from 'node:readline';
import { confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { MvmtConfig } from '../config/schema.js';
import { AuditEntry, AuditLogger, AUDIT_LOG_PATH } from '../utils/audit.js';
import { HttpRequestLogEntry } from '../server/index.js';
import { formatMcpPublicUrl } from '../utils/tunnel.js';
import { printApiTokenSaved, printApiTokens, promptAndAddApiToken, promptAndEditApiToken, promptAndRemoveApiToken, rotateApiTokenInConfig } from './api-tokens.js';
import { printConfigSummary } from './config.js';
import { printMounts, promptAndAddMount, promptAndEditMount, promptAndRemoveMount } from './mounts.js';
import { applyTunnelConfig, printTunnelEnabledWithNoTokens, promptForTunnelConfig } from './tunnel.js';
import { LoadedConnector } from './connector-loader.js';
import { TunnelController } from './tunnel-controller.js';
import { ToolResultPlugin } from '../plugins/types.js';

const SIGINT_EXIT_WINDOW_MS = 2_000;

export class InteractiveAuditLogger implements AuditLogger {
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

export interface InteractivePromptState {
  config: MvmtConfig;
  configPath: string;
  port: number;
  tunnel: TunnelController;
  loaded: LoadedConnector[];
  plugins: ToolResultPlugin[];
  totalTools: number;
  audit: InteractiveAuditLogger;
  shutdown: () => Promise<void>;
  persistConfig: () => Promise<void>;
}

export function startInteractivePrompt(state: InteractivePromptState): void {
  let handlingCommand = false;
  let lastSigintAt = 0;
  let promptSuspended = false;
  let rl: readline.Interface | undefined;

  const writeAbovePrompt = (message: string) => {
    if (promptSuspended || !rl) {
      console.log(message);
      return;
    }
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    console.log(message);
    rl.prompt(true);
  };

  state.audit.setWriter(writeAbovePrompt);

  const suspendPrompt = () => {
    promptSuspended = true;
    rl?.close();
    rl = undefined;
  };

  const resumePrompt = () => {
    promptSuspended = false;
    rl = createInteractiveReadline();
    attachReadlineHandlers(rl);
    rl.prompt();
  };

  const attachReadlineHandlers = (activeRl: readline.Interface) => {
    activeRl.on('line', async (line) => {
      if (handlingCommand) return;
      handlingCommand = true;
      lastSigintAt = 0;
      const command = line.trim().toLowerCase();
      const shouldContinue = command !== 'quit' && command !== 'exit';
      if (!shouldContinue) {
        activeRl.close();
        return;
      }
      suspendPrompt();
      try {
        await handleInteractiveCommand(command, state, activeRl);
      } catch (err) {
        if (isPromptCancelError(err)) {
          console.log(chalk.yellow('Canceled.'));
        } else {
          console.log(chalk.red(err instanceof Error ? err.message : 'Command failed'));
        }
      } finally {
        handlingCommand = false;
      }
      if (shouldContinue) {
        resumePrompt();
      }
    });

    activeRl.on('SIGINT', async () => {
      if (handlingCommand) return;
      const now = Date.now();
      if (shouldShutdownOnSigint(lastSigintAt, now)) {
        await state.shutdown();
        return;
      }
      lastSigintAt = now;
      console.log(chalk.yellow('Press Ctrl-C again to stop mvmt, or type "quit".'));
      activeRl.prompt();
    });

    activeRl.on('close', async () => {
      if (promptSuspended) return;
      await state.shutdown();
    });
  };

  resumePrompt();
}

function createInteractiveReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('> '),
  });
}

export function shouldShutdownOnSigint(lastSigintAt: number, now: number): boolean {
  return lastSigintAt > 0 && now - lastSigintAt <= SIGINT_EXIT_WINDOW_MS;
}

export function isPromptCancelError(err: unknown): boolean {
  return err instanceof Error
    && (
      err.name === 'ExitPromptError'
      || err.message.includes('User force closed the prompt')
      || err.message.includes('force closed')
    );
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
    case 'token list':
    case 'token show':
      printApiTokens(state.config);
      return;
    case 'token add':
      await handleTokensAdd(state);
      return;
    case 'token edit':
      await handleTokensEdit(state);
      return;
    case 'token rotate':
      await handleTokensRotate(state);
      return;
    case 'token remove':
      await handleTokensRemove(state);
      return;
    case 'tokens':
    case 'tokens list':
      printApiTokens(state.config);
      return;
    case 'tokens add':
      await handleTokensAdd(state);
      return;
    case 'tokens edit':
      await handleTokensEdit(state);
      return;
    case 'tokens rotate':
      await handleTokensRotate(state);
      return;
    case 'tokens remove':
      await handleTokensRemove(state);
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
    case 'mounts':
      printMounts(state.config);
      return;
    case 'mounts add':
      await handleMountsAdd(state);
      return;
    case 'mounts edit':
      await handleMountsEdit(state);
      return;
    case 'mounts remove':
      await handleMountsRemove(state);
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
  console.log('  token               list scoped API tokens');
  console.log('  token add/edit      manage scoped API tokens');
  console.log('  token rotate        rotate a scoped API token');
  console.log('  token remove        remove a scoped API token');
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
  console.log('  mounts      list configured mounts');
  console.log('  mounts add/edit/remove');
  console.log('  clear       clear the terminal');
  console.log('  quit        stop mvmt');
  console.log('');
}

function printLiveLogState(state: InteractivePromptState): void {
  console.log(`live logs: ${state.audit.getLiveLogs() ? chalk.green('on') : chalk.dim('off')}`);
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
  printMounts(state.config);
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
  const wasLocalOnly = state.config.server.access !== 'tunnel';
  const tunnel = await state.tunnel.start({ enable: true });
  if (wasLocalOnly && state.config.server.access === 'tunnel') {
    await state.persistConfig();
  }
  if (tunnel?.url) {
    console.log(`public URL  ${chalk.yellow(formatMcpPublicUrl(tunnel.url))}`);
  }
  if ((state.config.clients?.length ?? 0) === 0 && state.config.server.access === 'tunnel') {
    console.log(chalk.dim('No API tokens are configured. Run `token add` before expecting MCP data access over the tunnel.'));
  }
}

async function handleTunnelRefresh(state: InteractivePromptState): Promise<void> {
  if (!state.tunnel.configured) {
    console.log(chalk.yellow('No tunnel is configured. Run `tunnel config` or `mvmt tunnel config`.'));
    return;
  }
  console.log('Refreshing tunnel...');
  const wasLocalOnly = state.config.server.access !== 'tunnel';
  const tunnel = await state.tunnel.refresh({ enable: true });
  if (wasLocalOnly && state.config.server.access === 'tunnel') {
    await state.persistConfig();
  }
  if (tunnel?.url) {
    console.log(`public URL  ${chalk.yellow(formatMcpPublicUrl(tunnel.url))}`);
  } else {
    console.log(chalk.yellow('Tunnel refreshed, but no public URL was detected yet.'));
  }
}

async function handleTunnelConfig(state: InteractivePromptState): Promise<void> {
  const tunnel = await promptForTunnelConfig(state.port);
  const applied = applyTunnelConfig(state.config, tunnel);
  const wasRunning = state.tunnel.running;

  if (wasRunning) {
    await state.tunnel.stop();
  }

  state.config.server.access = applied.config.server.access;
  state.config.server.tunnel = tunnel;
  await state.persistConfig();

  console.log(chalk.green(`Tunnel config saved to ${state.configPath}`));
  if (applied.warning) {
    printTunnelEnabledWithNoTokens(applied.warning);
  }

  state.tunnel.configure(tunnel);
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

function printConnectorSummary(loaded: LoadedConnector[], totalTools: number): void {
  console.log(chalk.bold('connectors'));
  for (const entry of loaded) {
    console.log(`  ${chalk.green('ok')} ${entry.connector.id.padEnd(22)} ${String(entry.toolCount).padStart(3)} tools`);
  }
  console.log(`  ${chalk.dim('total'.padEnd(25))} ${String(totalTools).padStart(3)} tools`);
}

async function handleMountsAdd(state: InteractivePromptState): Promise<void> {
  const nextConfig = await promptAndAddMount(state.config);
  if (!nextConfig) return;
  state.config.mounts = nextConfig.mounts;
  await state.persistConfig();
  console.log(chalk.green(`Mounts saved to ${state.configPath}`));
  console.log(chalk.dim('Restart mvmt for the running server to load mount changes. Run `mvmt reindex` to rebuild the index.'));
}

async function handleMountsEdit(state: InteractivePromptState): Promise<void> {
  const nextConfig = await promptAndEditMount(state.config);
  if (!nextConfig) return;
  state.config.mounts = nextConfig.mounts;
  await state.persistConfig();
  console.log(chalk.green(`Mounts saved to ${state.configPath}`));
  console.log(chalk.dim('Restart mvmt for the running server to load mount changes. Run `mvmt reindex` to rebuild the index.'));
}

async function handleMountsRemove(state: InteractivePromptState): Promise<void> {
  const nextConfig = await promptAndRemoveMount(state.config);
  if (!nextConfig) {
    console.log(chalk.yellow('Mount config unchanged.'));
    return;
  }
  state.config.mounts = nextConfig.mounts;
  await state.persistConfig();
  console.log(chalk.green(`Mounts saved to ${state.configPath}`));
  console.log(chalk.dim('Restart mvmt for the running server to load mount changes. Run `mvmt reindex` to rebuild the index.'));
}

async function handleTokensAdd(state: InteractivePromptState): Promise<void> {
  const result = await promptAndAddApiToken(state.config);
  if (!result) return;
  state.config.clients = result.config.clients;
  await state.persistConfig();
  printApiTokenSaved(state.configPath, result);
}

async function handleTokensEdit(state: InteractivePromptState): Promise<void> {
  const result = await promptAndEditApiToken(state.config);
  if (!result) return;
  state.config.clients = result.config.clients;
  await state.persistConfig();
  printApiTokenSaved(state.configPath, result);
}

async function handleTokensRotate(state: InteractivePromptState): Promise<void> {
  const tokenId = await promptForInteractiveTokenId(state.config, 'Rotate which API token?');
  const ok = await confirm({
    message: `Rotate token ${tokenId}? Connected clients using it will lose access until reconfigured.`,
    default: false,
  });
  if (!ok) {
    console.log(chalk.yellow('Token config unchanged.'));
    return;
  }
  const result = rotateApiTokenInConfig(state.config, tokenId);
  state.config.clients = result.config.clients;
  await state.persistConfig();
  printApiTokenSaved(state.configPath, result);
}

async function handleTokensRemove(state: InteractivePromptState): Promise<void> {
  const nextConfig = await promptAndRemoveApiToken(state.config);
  if (!nextConfig) {
    console.log(chalk.yellow('API token config unchanged.'));
    return;
  }
  state.config.clients = nextConfig.clients;
  await state.persistConfig();
  console.log(chalk.green(`API token config saved to ${state.configPath}`));
}

async function promptForInteractiveTokenId(config: MvmtConfig, message: string): Promise<string> {
  const tokens = (config.clients ?? []).filter((client) => client.auth.type === 'token');
  if (tokens.length === 0) throw new Error('No API tokens configured.');
  return select({
    message,
    choices: tokens.map((client) => ({
      name: `${client.id} (${client.name})`,
      value: client.id,
    })),
  });
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

export function formatAuditEntry(entry: AuditEntry): string {
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

export function formatHttpRequestEntry(entry: HttpRequestLogEntry): string {
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
