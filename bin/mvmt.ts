#!/usr/bin/env node

import { Command } from 'commander';
import { doctor } from '../src/cli/doctor.js';
import { init } from '../src/cli/init.js';
import { start } from '../src/cli/start.js';
import { rotateToken, showToken } from '../src/cli/token.js';
import { maybePrintUpdateNotice, readPackageInfo } from '../src/utils/version.js';

const packageInfo = readPackageInfo();
const argv = process.argv.slice(2);

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

program.hook('preAction', async (thisCommand, actionCommand) => {
  const globalOptions = thisCommand.opts<{ updateCheck?: boolean }>();
  if (globalOptions.updateCheck === false) return;
  if (actionCommand.name() === 'doctor') return;
  if (isTokenCommand(actionCommand)) return;

  const actionOptions = actionCommand.opts<{ stdio?: boolean }>();
  if (actionCommand.name() === 'start' && actionOptions.stdio) return;

  await maybePrintUpdateNotice({ packageInfo });
});

program
  .command('init')
  .description('Interactive setup wizard: choose local folders and native connectors')
  .action(async () => {
    await init();
  });

program
  .command('start')
  .description('Start the unified MCP server')
  .option('-p, --port <number>', 'Override port')
  .option('-c, --config <path>', 'Config file path')
  .option('--stdio', 'Use stdio transport')
  .option('-i, --interactive', 'Start an interactive control prompt')
  .option('-v, --verbose', 'Verbose logging')
  .action(async (options: { port?: string; config?: string; stdio?: boolean; interactive?: boolean; verbose?: boolean }) => {
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

const tokenCommand = program.command('token').description('Manage the HTTP bearer token');

tokenCommand
  .command('show')
  .description('Print the current HTTP bearer token without regenerating it')
  .action(async () => {
    await showToken();
  });

tokenCommand
  .command('rotate')
  .description('Regenerate and print the HTTP bearer token')
  .action(async () => {
    await rotateToken();
  });

await program.parseAsync();

function isTokenCommand(command: Command): boolean {
  let current: Command | null = command;
  while (current) {
    if (current.name() === 'token') return true;
    current = current.parent;
  }
  return false;
}
