import { confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { getConfigPath, loadConfig, saveConfig } from '../config/loader.js';
import { FolderSourceConfig, FolderSourceSchema, MvmtConfig } from '../config/schema.js';
import { resolveSetupPath } from '../connectors/setup-paths.js';

export interface SourceCommandOptions {
  config?: string;
}

export interface AddSourceOptions extends SourceCommandOptions {
  write?: boolean;
  readOnly?: boolean;
  exclude?: string[];
  protect?: string[];
  disabled?: boolean;
}

export interface EditSourceOptions extends SourceCommandOptions {
  path?: string;
  write?: boolean;
  readOnly?: boolean;
  exclude?: string[];
  protect?: string[];
  enable?: boolean;
  disable?: boolean;
}

export interface SourceInput {
  id: string;
  path: string;
  writeAccess: boolean;
  exclude?: string[];
  protect?: string[];
  enabled?: boolean;
}

export async function listSources(options: SourceCommandOptions = {}): Promise<void> {
  const config = loadConfig(resolveSourcesConfigPath(options.config));
  printSources(config);
}

export async function addSource(id: string | undefined, folderPath: string | undefined, options: AddSourceOptions = {}): Promise<void> {
  assertWriteFlags(options);
  const configPath = resolveSourcesConfigPath(options.config);
  const config = loadConfig(configPath);
  const inputValue = id && folderPath
    ? sourceInputFromOptions(id, folderPath, options)
    : await promptForSourceInput(config);

  const nextConfig = addSourceToConfig(config, inputValue);
  await saveConfig(configPath, nextConfig);
  console.log(chalk.green(`Source ${inputValue.id} saved to ${configPath}`));
  console.log(chalk.dim('Restart mvmt for the running server to load source changes. Run `mvmt reindex` to rebuild the index.'));
}

export async function editSource(id: string | undefined, options: EditSourceOptions = {}): Promise<void> {
  assertWriteFlags(options);
  assertEnableFlags(options);
  const configPath = resolveSourcesConfigPath(options.config);
  const config = loadConfig(configPath);
  const sourceId = id ?? await promptForSourceId(config, 'Edit which source?');
  const patch = hasEditOptions(options)
    ? sourcePatchFromOptions(options)
    : await promptForSourcePatch(config, sourceId);

  const nextConfig = editSourceInConfig(config, sourceId, patch);
  await saveConfig(configPath, nextConfig);
  console.log(chalk.green(`Source ${sourceId} updated in ${configPath}`));
  console.log(chalk.dim('Restart mvmt for the running server to load source changes. Run `mvmt reindex` to rebuild the index.'));
}

export async function removeSource(id: string | undefined, options: SourceCommandOptions = {}): Promise<void> {
  const configPath = resolveSourcesConfigPath(options.config);
  const config = loadConfig(configPath);
  const sourceId = id ?? await promptForSourceId(config, 'Remove which source?');
  const ok = await confirm({
    message: `Remove source ${sourceId}? Client permissions that reference it will become invalid.`,
    default: false,
  });
  if (!ok) {
    console.log(chalk.yellow('Source config unchanged.'));
    return;
  }

  const nextConfig = removeSourceFromConfig(config, sourceId);
  await saveConfig(configPath, nextConfig);
  console.log(chalk.green(`Source ${sourceId} removed from ${configPath}`));
  console.log(chalk.dim('Restart mvmt for the running server to unload source changes. Run `mvmt reindex` to rebuild the index.'));
}

export function printSources(config: MvmtConfig): void {
  console.log(chalk.bold('Folder sources'));
  if (config.sources.length === 0) {
    console.log(`  ${chalk.dim('none')}`);
    return;
  }

  for (const source of config.sources) {
    const state = source.enabled === false ? chalk.dim('disabled') : chalk.green('enabled');
    const access = source.writeAccess ? chalk.yellow('read/write') : chalk.dim('read-only');
    console.log(`  ${source.id.padEnd(16)} ${state}  ${access}  ${source.path}`);
    if (source.exclude.length > 0) console.log(`    exclude: ${source.exclude.join(', ')}`);
    if (source.protect.length > 0) console.log(`    protect: ${source.protect.join(', ')}`);
  }
}

export function addSourceToConfig(config: MvmtConfig, sourceInput: SourceInput): MvmtConfig {
  if (config.sources.some((source) => source.id === sourceInput.id)) {
    throw new Error(`Source already exists: ${sourceInput.id}`);
  }
  const source = normalizeSourceInput(sourceInput);
  return { ...config, sources: [...config.sources, source] };
}

export function editSourceInConfig(config: MvmtConfig, id: string, patch: Partial<SourceInput>): MvmtConfig {
  const index = config.sources.findIndex((source) => source.id === id);
  if (index < 0) throw new Error(`Unknown source: ${id}`);
  const current = config.sources[index];
  const updated = normalizeSourceInput({
    id: current.id,
    path: patch.path ?? current.path,
    writeAccess: patch.writeAccess ?? current.writeAccess,
    exclude: patch.exclude ?? current.exclude,
    protect: patch.protect ?? current.protect,
    enabled: patch.enabled ?? current.enabled,
  });
  return {
    ...config,
    sources: [
      ...config.sources.slice(0, index),
      updated,
      ...config.sources.slice(index + 1),
    ],
  };
}

export function removeSourceFromConfig(config: MvmtConfig, id: string): MvmtConfig {
  if (!config.sources.some((source) => source.id === id)) {
    throw new Error(`Unknown source: ${id}`);
  }
  assertSourceNotReferenced(config, id);
  return { ...config, sources: config.sources.filter((source) => source.id !== id) };
}

export async function promptAndAddSource(config: MvmtConfig): Promise<MvmtConfig | undefined> {
  const source = await promptForSourceInput(config);
  return addSourceToConfig(config, source);
}

export async function promptAndEditSource(config: MvmtConfig): Promise<MvmtConfig | undefined> {
  if (config.sources.length === 0) {
    console.log(chalk.yellow('No folder sources configured.'));
    return undefined;
  }
  const id = await promptForSourceId(config, 'Edit which source?');
  const patch = await promptForSourcePatch(config, id);
  return editSourceInConfig(config, id, patch);
}

export async function promptAndRemoveSource(config: MvmtConfig): Promise<MvmtConfig | undefined> {
  if (config.sources.length === 0) {
    console.log(chalk.yellow('No folder sources configured.'));
    return undefined;
  }
  const id = await promptForSourceId(config, 'Remove which source?');
  const ok = await confirm({ message: `Remove source ${id}?`, default: false });
  return ok ? removeSourceFromConfig(config, id) : undefined;
}

function resolveSourcesConfigPath(configPath?: string): string {
  return configPath ? resolveSetupPath(configPath) : getConfigPath();
}

function normalizeSourceInput(inputValue: SourceInput): FolderSourceConfig {
  return FolderSourceSchema.parse({
    id: inputValue.id,
    type: 'folder',
    path: resolveSetupPath(inputValue.path),
    ...(inputValue.exclude ? { exclude: inputValue.exclude } : {}),
    ...(inputValue.protect ? { protect: inputValue.protect } : {}),
    writeAccess: inputValue.writeAccess,
    enabled: inputValue.enabled ?? true,
  });
}

function sourceInputFromOptions(id: string, folderPath: string, options: AddSourceOptions): SourceInput {
  return {
    id,
    path: folderPath,
    writeAccess: Boolean(options.write),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(options.protect ? { protect: options.protect } : {}),
    enabled: !options.disabled,
  };
}

function sourcePatchFromOptions(options: EditSourceOptions): Partial<SourceInput> {
  return {
    ...(options.path ? { path: options.path } : {}),
    ...(options.write ? { writeAccess: true } : {}),
    ...(options.readOnly ? { writeAccess: false } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(options.protect ? { protect: options.protect } : {}),
    ...(options.enable ? { enabled: true } : {}),
    ...(options.disable ? { enabled: false } : {}),
  };
}

async function promptForSourceInput(config: MvmtConfig): Promise<SourceInput> {
  const id = await input({
    message: 'Source id:',
    validate: (value) => {
      const trimmed = value.trim();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) return 'Use lowercase letters, numbers, dash, or underscore';
      if (config.sources.some((source) => source.id === trimmed)) return `Source already exists: ${trimmed}`;
      return true;
    },
  });
  const folderPath = await input({
    message: 'Folder path:',
    validate: (value) => value.trim().length > 0 ? true : 'Enter a folder path',
  });
  const writeAccess = await confirm({
    message: 'Allow write/delete in this folder?',
    default: false,
  });
  const exclude = splitPatterns(await input({
    message: 'Exclude patterns (comma-separated):',
    default: '.git/**, node_modules/**, .claude/**',
  }));
  const protect = splitPatterns(await input({
    message: 'Protected write/delete patterns (comma-separated):',
    default: '.env, .env.*, .claude/**',
  }));
  return { id: id.trim(), path: folderPath.trim(), writeAccess, exclude, protect, enabled: true };
}

async function promptForSourcePatch(config: MvmtConfig, id: string): Promise<Partial<SourceInput>> {
  const current = config.sources.find((source) => source.id === id);
  if (!current) throw new Error(`Unknown source: ${id}`);
  const folderPath = await input({ message: 'Folder path:', default: current.path });
  const writeAccess = await confirm({
    message: 'Allow write/delete in this folder?',
    default: current.writeAccess,
  });
  const enabled = await confirm({
    message: 'Enable this source?',
    default: current.enabled,
  });
  const exclude = splitPatterns(await input({
    message: 'Exclude patterns (comma-separated):',
    default: current.exclude.join(', '),
  }));
  const protect = splitPatterns(await input({
    message: 'Protected write/delete patterns (comma-separated):',
    default: current.protect.join(', '),
  }));
  return { path: folderPath.trim(), writeAccess, enabled, exclude, protect };
}

async function promptForSourceId(config: MvmtConfig, message: string): Promise<string> {
  if (config.sources.length === 0) throw new Error('No folder sources configured.');
  return select({
    message,
    choices: config.sources.map((source) => ({
      name: `${source.id} (${source.path})`,
      value: source.id,
    })),
  });
}

function splitPatterns(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function assertWriteFlags(options: { write?: boolean; readOnly?: boolean }): void {
  if (options.write && options.readOnly) {
    throw new Error('Use either --write or --read-only, not both.');
  }
}

function assertEnableFlags(options: { enable?: boolean; disable?: boolean }): void {
  if (options.enable && options.disable) {
    throw new Error('Use either --enable or --disable, not both.');
  }
}

function hasEditOptions(options: EditSourceOptions): boolean {
  return Boolean(
    options.path ||
    options.write ||
    options.readOnly ||
    options.exclude ||
    options.protect ||
    options.enable ||
    options.disable
  );
}

function assertSourceNotReferenced(config: MvmtConfig, id: string): void {
  for (const client of config.clients ?? []) {
    if (client.permissions.some((permission) => permission.sourceId === id)) {
      throw new Error(`Source ${id} is still referenced by client ${client.id}`);
    }
  }

  const semantic = config.semanticTools;
  if (semantic?.searchPersonalContext?.sourceIds.includes(id)) {
    throw new Error(`Source ${id} is still referenced by semanticTools.searchPersonalContext`);
  }
  if (semantic?.readContextItem?.sourceIds.includes(id)) {
    throw new Error(`Source ${id} is still referenced by semanticTools.readContextItem`);
  }
}
