import readline from 'node:readline';
import chalk from 'chalk';
import { MvmtConfig } from '../config/schema.js';
import { AuditEntry, AuditLogger, AUDIT_LOG_PATH } from '../utils/audit.js';
import { HttpRequestLogEntry } from '../server/index.js';
import { generateSessionToken, rotateSigningKey, TOKEN_PATH, defaultSigningKeyPath } from '../utils/token.js';
import { formatMcpPublicUrl } from '../utils/tunnel.js';
import { printTokenSummary, readTokenSummary } from './token.js';
import { printConfigSummary } from './config.js';
import { printSources, promptAndAddSource, promptAndEditSource, promptAndRemoveSource } from './sources.js';
import { promptForTunnelConfig } from './tunnel.js';
import { LoadedConnector } from './connector-loader.js';
import { TunnelController } from './tunnel-controller.js';
import { ToolResultPlugin } from '../plugins/types.js';

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
    case 'sources':
      printSources(state.config);
      return;
    case 'sources add':
      await handleSourcesAdd(state);
      return;
    case 'sources edit':
      await handleSourcesEdit(state);
      return;
    case 'sources remove':
      await handleSourcesRemove(state);
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
  console.log('  sources     list text-index folder sources');
  console.log('  sources add/edit/remove');
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
  console.log(
    chalk.yellow('Token rotated. HTTP clients storing the old token must update it. OAuth access tokens were revoked immediately.'),
  );
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
  printSources(state.config);
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
  await state.persistConfig();

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

function printConnectorSummary(loaded: LoadedConnector[], totalTools: number): void {
  console.log(chalk.bold('connectors'));
  for (const entry of loaded) {
    console.log(`  ${chalk.green('ok')} ${entry.connector.id.padEnd(22)} ${String(entry.toolCount).padStart(3)} tools`);
  }
  console.log(`  ${chalk.dim('total'.padEnd(25))} ${String(totalTools).padStart(3)} tools`);
}

async function handleSourcesAdd(state: InteractivePromptState): Promise<void> {
  const nextConfig = await promptAndAddSource(state.config);
  if (!nextConfig) return;
  state.config.sources = nextConfig.sources;
  await state.persistConfig();
  console.log(chalk.green(`Sources saved to ${state.configPath}`));
  console.log(chalk.dim('Restart mvmt for the running server to load source changes. Run `mvmt reindex` to rebuild the index.'));
}

async function handleSourcesEdit(state: InteractivePromptState): Promise<void> {
  const nextConfig = await promptAndEditSource(state.config);
  if (!nextConfig) return;
  state.config.sources = nextConfig.sources;
  await state.persistConfig();
  console.log(chalk.green(`Sources saved to ${state.configPath}`));
  console.log(chalk.dim('Restart mvmt for the running server to load source changes. Run `mvmt reindex` to rebuild the index.'));
}

async function handleSourcesRemove(state: InteractivePromptState): Promise<void> {
  const nextConfig = await promptAndRemoveSource(state.config);
  if (!nextConfig) {
    console.log(chalk.yellow('Source config unchanged.'));
    return;
  }
  state.config.sources = nextConfig.sources;
  await state.persistConfig();
  console.log(chalk.green(`Sources saved to ${state.configPath}`));
  console.log(chalk.dim('Restart mvmt for the running server to load source changes. Run `mvmt reindex` to rebuild the index.'));
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
