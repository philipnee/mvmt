#!/usr/bin/env node

import { Command } from 'commander';
import { addConnector, listConnectors } from '../src/cli/connectors.js';
import { runConfigSetup, showConfig } from '../src/cli/config.js';
import { doctor } from '../src/cli/doctor.js';
import { init } from '../src/cli/init.js';
import { reindex } from '../src/cli/reindex.js';
import { addSource, editSource, listSources, removeSource } from '../src/cli/sources.js';
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

program
  .command('reindex')
  .description('Rebuild the prototype text context index')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await reindex(options);
  });

const sourcesCommand = program
  .command('sources')
  .description('Manage prototype text-index folder sources')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await listSources(options);
  });

sourcesCommand
  .command('list')
  .description('List configured folder sources')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }) => {
    await listSources(options);
  });

sourcesCommand
  .command('add [id] [path]')
  .description('Add a folder source')
  .option('-c, --config <path>', 'Config file path')
  .option('--write', 'Allow write/delete tools for this folder')
  .option('--read-only', 'Keep this folder read-only')
  .option('--exclude <pattern>', 'Exclude glob pattern (repeatable)', collectValues)
  .option('--protect <pattern>', 'Protected write/delete glob pattern (repeatable)', collectValues)
  .option('--disabled', 'Add the source disabled')
  .action(async (id: string | undefined, folderPath: string | undefined, options: { config?: string; write?: boolean; readOnly?: boolean; exclude?: string[]; protect?: string[]; disabled?: boolean }) => {
    await addSource(id, folderPath, options);
  });

sourcesCommand
  .command('edit [id]')
  .description('Edit a folder source')
  .option('-c, --config <path>', 'Config file path')
  .option('--path <path>', 'New folder path')
  .option('--write', 'Allow write/delete tools for this folder')
  .option('--read-only', 'Make this folder read-only')
  .option('--exclude <pattern>', 'Replace exclude glob patterns (repeatable)', collectValues)
  .option('--protect <pattern>', 'Replace protected write/delete glob patterns (repeatable)', collectValues)
  .option('--enable', 'Enable this source')
  .option('--disable', 'Disable this source')
  .action(async (id: string | undefined, options: { config?: string; path?: string; write?: boolean; readOnly?: boolean; exclude?: string[]; protect?: string[]; enable?: boolean; disable?: boolean }) => {
    await editSource(id, options);
  });

sourcesCommand
  .command('remove [id]')
  .description('Remove a folder source')
  .option('-c, --config <path>', 'Config file path')
  .action(async (id: string | undefined, options: { config?: string }) => {
    await removeSource(id, options);
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
