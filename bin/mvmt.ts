#!/usr/bin/env node

import { Command } from 'commander';
import { withInheritedConfig } from '../src/cli/command-options.js';
import { addConnector, listConnectors } from '../src/cli/connectors.js';
import { runConfigSetup, showConfig } from '../src/cli/config.js';
import { doctor } from '../src/cli/doctor.js';
import { init } from '../src/cli/init.js';
import { reindex } from '../src/cli/reindex.js';
import { addMount, editMount, listMounts, removeMount } from '../src/cli/mounts.js';
import { start } from '../src/cli/start.js';
import {
  configureTunnel,
  disableTunnelAccess,
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
  .description('Mount selected local folders and serve them over MCP')
  .option('-V, --version', 'Print mvmt version and check for updates')
  .option('--no-update-check', 'Skip automatic npm update checks');
program.showHelpAfterError();
program.showSuggestionAfterError();
program.addHelpText('after', examples([
  ['mvmt serve -i', 'start locally with the interactive prompt'],
  ['mvmt serve --path ~/Documents', 'serve one read-only folder for this run'],
  ['mvmt mounts add notes ~/notes --mount-path /notes --read-only', 'add a read-only mount'],
  ['mvmt doctor', 'validate config and mount roots'],
]));

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
  .addHelpText('after', examples([
    ['mvmt serve -i', 'start HTTP mode with the interactive prompt'],
    ['mvmt serve --stdio', 'start stdio mode for a client that launches mvmt'],
    ['mvmt serve --path ~/Documents', 'temporarily serve one folder as read-only'],
  ]))
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

const mountsCommand = program
  .command('mounts')
  .description('Manage local folder mounts')
  .option('-c, --config <path>', 'Config file path')
  .option('--json', 'Output as JSON')
  .action(async (options: { config?: string; json?: boolean }) => {
    await listMounts(options);
  });

mountsCommand
  .command('list')
  .description('List configured mounts')
  .option('-c, --config <path>', 'Config file path')
  .option('--json', 'Output as JSON')
  .action(async (options: { config?: string; json?: boolean }, command: Command) => {
    await listMounts(withInheritedConfig(options, command));
  });

mountsCommand
  .command('add [name] [root]')
  .description('Add a local folder mount')
  .option('-c, --config <path>', 'Config file path')
  .option('--mount-path <path>', 'Virtual mount path, such as /notes')
  .option('--write', 'Allow write/remove tools for this mount')
  .option('--read-only', 'Keep this mount read-only')
  .option('--description <text>', 'Short description shown to clients when listing mounts')
  .option('--guidance <text>', 'Mount-specific instructions shown to clients when listing mounts')
  .option('--exclude <pattern>', 'Exclude glob pattern (repeatable)', collectValues)
  .option('--protect <pattern>', 'Protected write/remove glob pattern (repeatable)', collectValues)
  .option('--disabled', 'Add the mount disabled')
  .addHelpText('after', examples([
    ['mvmt mounts add notes ~/notes --mount-path /notes --read-only', 'add a read-only notes mount'],
    ['mvmt mounts add workspace ~/code/mvmt --mount-path /workspace --write', 'add a writable project mount'],
  ]))
  .action(async (name: string | undefined, root: string | undefined, options: { config?: string; mountPath?: string; write?: boolean; readOnly?: boolean; description?: string; guidance?: string; exclude?: string[]; protect?: string[]; disabled?: boolean }, command: Command) => {
    await addMount(name, root, withInheritedConfig(options, command));
  });

mountsCommand
  .command('edit [name]')
  .description('Edit a local folder mount')
  .option('-c, --config <path>', 'Config file path')
  .option('--root <path>', 'New local folder root')
  .option('--mount-path <path>', 'New virtual mount path, such as /notes')
  .option('--write', 'Allow write/remove tools for this mount')
  .option('--read-only', 'Make this mount read-only')
  .option('--description <text>', 'Replace the mount description shown to clients')
  .option('--guidance <text>', 'Replace the mount-specific instructions shown to clients')
  .option('--exclude <pattern>', 'Replace exclude glob patterns (repeatable)', collectValues)
  .option('--protect <pattern>', 'Replace protected write/remove glob patterns (repeatable)', collectValues)
  .option('--enable', 'Enable this mount')
  .option('--disable', 'Disable this mount')
  .action(async (name: string | undefined, options: { config?: string; root?: string; mountPath?: string; write?: boolean; readOnly?: boolean; description?: string; guidance?: string; exclude?: string[]; protect?: string[]; enable?: boolean; disable?: boolean }, command: Command) => {
    await editMount(name, withInheritedConfig(options, command));
  });

mountsCommand
  .command('remove [name]')
  .description('Remove a mount')
  .option('-c, --config <path>', 'Config file path')
  .option('-y, --yes', 'Remove without prompting for confirmation')
  .addHelpText('after', examples([
    ['mvmt mounts remove notes', 'prompt before removing the notes mount'],
    ['mvmt mounts remove notes --yes', 'remove the notes mount without an interactive prompt'],
  ]))
  .action(async (name: string | undefined, options: { config?: string; yes?: boolean }, command: Command) => {
    await removeMount(name, withInheritedConfig(options, command));
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
  .action(async (options: { config?: string }, command: Command) => {
    await runConfigSetup({ config: withInheritedConfig(options, command).config });
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
  .action(async (options: { config?: string }, command: Command) => {
    await configureTunnel(withInheritedConfig(options, command));
  });

tunnelCommand
  .command('start')
  .description('Start the configured tunnel for the running mvmt process')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }, command: Command) => {
    await startTunnelCommand(withInheritedConfig(options, command));
  });

tunnelCommand
  .command('refresh')
  .description('Restart the configured tunnel and print the new URL')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }, command: Command) => {
    await refreshTunnelCommand(withInheritedConfig(options, command));
  });

tunnelCommand
  .command('stop')
  .description('Stop public tunnel exposure without stopping mvmt')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }, command: Command) => {
    await stopTunnelCommand(withInheritedConfig(options, command));
  });

tunnelCommand
  .command('disable')
  .description('Disable tunnel access in config and keep saved tunnel details')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }, command: Command) => {
    await disableTunnelAccess(withInheritedConfig(options, command));
  });

const tunnelLogsCommand = tunnelCommand
  .command('logs')
  .description('Show recent tunnel output')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }, command: Command) => {
    await showTunnelLogs(withInheritedConfig(options, command));
  });

tunnelLogsCommand
  .command('stream')
  .description('Stream live tunnel output from the running mvmt process')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }, command: Command) => {
    await streamTunnelLogs(withInheritedConfig(options, command));
  });

const connectorsCommand = program
  .command('connectors', { hidden: true })
  .description('Compatibility connector helpers');

connectorsCommand
  .command('list')
  .description('Show supported connector setup status')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options: { config?: string }, command: Command) => {
    await listConnectors(withInheritedConfig(options, command));
  });

connectorsCommand
  .command('add [name]')
  .description('Add a supported connector setup to config')
  .option('-c, --config <path>', 'Config file path')
  .action(async (name: string | undefined, options: { config?: string }, command: Command) => {
    await addConnector(name, withInheritedConfig(options, command));
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

function examples(rows: Array<[command: string, description: string]>): string {
  return [
    '',
    'Examples:',
    ...rows.flatMap(([command, description]) => [`  ${command}`, `      ${description}`]),
  ].join('\n');
}
