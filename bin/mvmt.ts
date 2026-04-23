#!/usr/bin/env node

import { Command } from 'commander';
import { addConnector, listConnectors } from '../src/cli/connectors.js';
import { runConfigSetup, showConfig } from '../src/cli/config.js';
import { doctor } from '../src/cli/doctor.js';
import { init } from '../src/cli/init.js';
import { start } from '../src/cli/start.js';
import {
  configureTunnel,
  refreshTunnelCommand,
  showTunnel,
  showTunnelLogs,
  startTunnelCommand,
  stopTunnelCommand,
  streamTunnelLogs,
} from '../src/cli/tunnel.js';
import { rotateToken, showToken, showTokenSummary } from '../src/cli/token.js';
import { maybePrintUpdateNotice, readPackageInfo } from '../src/utils/version.js';

const packageInfo = readPackageInfo();
const argv = normalizeHelpArgs(process.argv.slice(2));

if (argv.includes('--version') || argv.includes('-V')) {
  console.log(`mvmt ${packageInfo.version}`);
  if (!argv.includes('--no-update-check')) {
    await maybePrintUpdateNotice({ packageInfo });
  }
  process.exit(0);
}

const program = new Command();

program
  .name('mvmt')
  .description('Expose personal local data through one MCP endpoint')
  .option('-V, --version', 'Print mvmt version and check for updates')
  .option('--no-update-check', 'Skip automatic npm update checks');
program.showHelpAfterError();

program.hook('preAction', async (thisCommand, actionCommand) => {
  const globalOptions = thisCommand.opts<{ updateCheck?: boolean }>();
  if (globalOptions.updateCheck === false) return;
  if (actionCommand.name() === 'doctor') return;
  if (isTokenCommand(actionCommand) || isTokenShortcutCommand(actionCommand)) return;

  const actionOptions = actionCommand.opts<{ stdio?: boolean }>();
  if ((actionCommand.name() === 'serve' || actionCommand.name() === 'start') && actionOptions.stdio) return;

  await maybePrintUpdateNotice({ packageInfo });
});

program
  .command('serve')
  .description('Configure mvmt if needed, then start the MCP server')
  .option('-p, --port <number>', 'Override port')
  .option('-c, --config <path>', 'Config file path')
  .option('--path <dir>', 'Temporarily expose a filesystem folder as read-only for this run only (repeatable)', collectValues)
  .option('--stdio', 'Use stdio transport')
  .option('-i, --interactive', 'Start an interactive control prompt')
  .option('-v, --verbose', 'Verbose logging')
  .action(async (options: { port?: string; config?: string; path?: string[]; stdio?: boolean; interactive?: boolean; verbose?: boolean }) => {
    await start(options);
  });

program
  .command('doctor')
  .description('Validate config and check connector health')
  .option('-c, --config <path>', 'Config file path')
  .option('--json', 'Output as JSON')
  .option('--timeout-ms <number>', 'Per-connector health-check timeout in milliseconds')
  .action(async (options: { config?: string; json?: boolean; timeoutMs?: string }) => {
    const globalOptions = program.opts<{ updateCheck?: boolean }>();
    await doctor({ ...options, updateCheck: globalOptions.updateCheck !== false });
  });

const configCommand = program
  .command('config')
  .description('Show the saved mvmt config')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await showConfig(options);
  });

configCommand
  .command('setup')
  .description('Run guided setup and save mvmt config')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await runConfigSetup({ config: options.config });
  });

const tokenCommand = program
  .command('token')
  .description('Show the current bearer token and age')
  .action(async () => {
    await showTokenSummary();
  });

tokenCommand
  .command('show', { hidden: true })
  .description('Compatibility alias for raw token output')
  .action(async () => {
    await showToken();
  });

tokenCommand
  .command('rotate')
  .description('Regenerate and print the current bearer token')
  .action(async () => {
    await rotateToken();
  });

const tunnelCommand = program
  .command('tunnel')
  .description('Show tunnel status or manage the active tunnel')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await showTunnel(options);
  });

tunnelCommand
  .command('config')
  .description('Choose a different tunnel and save it to config')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await configureTunnel(options);
  });

tunnelCommand
  .command('start')
  .description('Start the configured tunnel for the running mvmt process')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await startTunnelCommand(options);
  });

tunnelCommand
  .command('refresh')
  .description('Restart the configured tunnel and print the new URL')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await refreshTunnelCommand(options);
  });

tunnelCommand
  .command('stop')
  .description('Stop public tunnel exposure without stopping mvmt')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await stopTunnelCommand(options);
  });

const tunnelLogsCommand = tunnelCommand
  .command('logs')
  .description('Show recent tunnel output')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await showTunnelLogs(options);
  });

tunnelLogsCommand
  .command('stream')
  .description('Stream live tunnel output from the running mvmt process')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await streamTunnelLogs(options);
  });

const connectorsCommand = program
  .command('connectors', { hidden: true })
  .description('Compatibility connector helpers');

connectorsCommand
  .command('list')
  .description('Show supported connector setup status')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await listConnectors(options);
  });

connectorsCommand
  .command('add [name]')
  .description('Add a supported connector setup to config')
  .option('-c, --config <path>', 'Config file path')
  .action(async (name: string | undefined, options: { config?: string }) => {
    await addConnector(name, options);
  });

program
  .command('init', { hidden: true })
  .description('Compatibility alias for `mvmt config setup`')
  .action(async () => {
    await init();
  });

program
  .command('start', { hidden: true })
  .description('Compatibility alias for `mvmt serve`')
  .option('-p, --port <number>', 'Override port')
  .option('-c, --config <path>', 'Config file path')
  .option('--path <dir>', 'Temporarily expose a filesystem folder as read-only for this run only (repeatable)', collectValues)
  .option('--stdio', 'Use stdio transport')
  .option('-i, --interactive', 'Start an interactive control prompt')
  .option('-v, --verbose', 'Verbose logging')
  .action(async (options: { port?: string; config?: string; path?: string[]; stdio?: boolean; interactive?: boolean; verbose?: boolean }) => {
    await start(options);
  });

program
  .command('show', { hidden: true })
  .description('Compatibility alias for raw token output')
  .action(async () => {
    await showToken();
  });

program
  .command('rotate', { hidden: true })
  .description('Compatibility alias for `mvmt token rotate`')
  .action(async () => {
    await rotateToken();
  });

await program.parseAsync(['node', process.argv[1] ?? 'mvmt', ...argv]);

function isTokenCommand(command: Command): boolean {
  let current: Command | null = command;
  while (current) {
    if (current.name() === 'token') return true;
    current = current.parent;
  }
  return false;
}

function isTokenShortcutCommand(command: Command): boolean {
  return command.name() === 'show' || command.name() === 'rotate';
}

function normalizeHelpArgs(args: string[]): string[] {
  if (args.length > 1 && args.at(-1) === 'help' && args[0] !== 'help' && !args.includes('--help') && !args.includes('-h')) {
    return [...args.slice(0, -1), '--help'];
  }
  return args;
}

function collectValues(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}
