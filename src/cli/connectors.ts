import { confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';
import { expandHome, getConfigPath, loadConfig } from '../config/loader.js';
import { MvmtConfig, ProxyConfig } from '../config/schema.js';
import {
  createMemPalaceProxyConfig,
  detectMemPalace,
  promptForMemPalace,
} from './init.js';

export interface ConnectorCommandOptions {
  config?: string;
}

export interface ConnectorSetupStatus {
  name: 'filesystem' | 'obsidian' | 'mempalace';
  displayName: string;
  configured: boolean;
  addable: boolean;
  note: string;
}

export function getConnectorSetupStatuses(config: MvmtConfig): ConnectorSetupStatus[] {
  return [
    {
      name: 'filesystem',
      displayName: 'Filesystem',
      configured: hasEnabledProxy(config, 'filesystem'),
      addable: false,
      note: 'configured by mvmt config setup',
    },
    {
      name: 'obsidian',
      displayName: 'Obsidian',
      configured: config.obsidian?.enabled === true,
      addable: false,
      note: 'configured by mvmt config setup',
    },
    {
      name: 'mempalace',
      displayName: 'MemPalace',
      configured: hasEnabledProxy(config, 'mempalace'),
      addable: true,
      note: 'can be added with mvmt connectors add mempalace',
    },
  ];
}

export async function listConnectors(options: ConnectorCommandOptions = {}): Promise<void> {
  const config = loadConfig(options.config);
  const statuses = getConnectorSetupStatuses(config);

  console.log(chalk.bold('Connector setups'));
  for (const status of statuses) {
    const state = status.configured ? chalk.green('configured') : chalk.dim('not configured');
    console.log(`  ${status.displayName.padEnd(12)} ${state}  ${chalk.dim(status.note)}`);
  }
}

export async function addConnector(name?: string, options: ConnectorCommandOptions = {}): Promise<void> {
  const configPath = options.config ? path.resolve(expandHome(options.config)) : getConfigPath();
  const config = loadConfig(options.config);
  const connectorName = name || (await promptForConnectorToAdd(config));

  if (connectorName !== 'mempalace') {
    console.log(chalk.yellow(`Connector setup is not supported by this command yet: ${connectorName}`));
    console.log(chalk.dim('Run mvmt config setup to configure filesystem folders or Obsidian.'));
    return;
  }

  if (hasEnabledProxy(config, 'mempalace')) {
    const overwrite = await confirm({
      message: 'MemPalace is already configured. Replace its config?',
      default: false,
    });
    if (!overwrite) {
      console.log(chalk.yellow('MemPalace config unchanged.'));
      return;
    }
  }

  const detected = await detectMemPalace();
  const memPalace = await promptForMemPalace(detected);
  const nextConfig = upsertProxyConfig(config, createMemPalaceProxyConfig(memPalace));

  await saveConfig(configPath, nextConfig);
  console.log(chalk.green(`MemPalace connector saved to ${configPath}`));
  console.log(chalk.dim('Restart mvmt for the new connector to load.'));
}

export function upsertProxyConfig(config: MvmtConfig, proxyConfig: ProxyConfig): MvmtConfig {
  const proxy = config.proxy.filter((entry) => !sameProxyName(entry.name, proxyConfig.name));
  proxy.push(proxyConfig);
  return { ...config, proxy };
}

async function promptForConnectorToAdd(config: MvmtConfig): Promise<string> {
  const addable = getConnectorSetupStatuses(config).filter((status) => status.addable && !status.configured);
  if (addable.length === 0) {
    console.log(chalk.yellow('No supported unconfigured connector setups are available.'));
    console.log(chalk.dim('Run mvmt connectors list to see current connector setup status.'));
    process.exit(0);
  }

  return select({
    message: 'Which connector should mvmt add?',
    choices: addable.map((status) => ({
      name: status.displayName,
      value: status.name,
    })),
  });
}

async function saveConfig(configPath: string, config: MvmtConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml.stringify(config), 'utf-8');
  if (process.platform !== 'win32') {
    await fs.chmod(configPath, 0o600);
  }
}

function hasEnabledProxy(config: MvmtConfig, name: string): boolean {
  return config.proxy.some((proxy) => sameProxyName(proxy.name, name) && proxy.enabled !== false);
}

function sameProxyName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
