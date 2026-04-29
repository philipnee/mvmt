import { confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { getConfigPath, loadConfig, saveConfig } from '../config/loader.js';
import { LocalFolderMountConfig, LocalFolderMountSchema, MvmtConfig } from '../config/schema.js';
import { resolveSetupPath } from '../connectors/setup-paths.js';
import { normalizePathSeparators, stripTrailingSlashes } from '../context/mount-registry.js';

export interface MountCommandOptions {
  config?: string;
}

export interface AddMountOptions extends MountCommandOptions {
  mountPath?: string;
  write?: boolean;
  readOnly?: boolean;
  description?: string;
  guidance?: string;
  exclude?: string[];
  protect?: string[];
  disabled?: boolean;
}

export interface EditMountOptions extends MountCommandOptions {
  root?: string;
  mountPath?: string;
  write?: boolean;
  readOnly?: boolean;
  description?: string;
  guidance?: string;
  exclude?: string[];
  protect?: string[];
  enable?: boolean;
  disable?: boolean;
}

export interface MountInput {
  name: string;
  root: string;
  path?: string;
  writeAccess: boolean;
  description?: string;
  guidance?: string;
  exclude?: string[];
  protect?: string[];
  enabled?: boolean;
}

export async function listMounts(options: MountCommandOptions = {}): Promise<void> {
  const config = loadConfig(resolveMountsConfigPath(options.config));
  printMounts(config);
}

export async function addMount(name: string | undefined, root: string | undefined, options: AddMountOptions = {}): Promise<void> {
  assertWriteFlags(options);
  const configPath = resolveMountsConfigPath(options.config);
  const config = loadConfig(configPath);
  const inputValue = name && root
    ? mountInputFromOptions(name, root, options)
    : await promptForMountInput(config);

  const nextConfig = addMountToConfig(config, inputValue);
  await saveConfig(configPath, nextConfig);
  console.log(chalk.green(`Mount ${inputValue.name} saved to ${configPath}`));
  console.log(chalk.dim('Restart mvmt for the running server to load mount changes. Run `mvmt reindex` to rebuild the index.'));
}

export async function editMount(name: string | undefined, options: EditMountOptions = {}): Promise<void> {
  assertWriteFlags(options);
  assertEnableFlags(options);
  const configPath = resolveMountsConfigPath(options.config);
  const config = loadConfig(configPath);
  const mountName = name ?? await promptForMountName(config, 'Edit which mount?');
  const patch = hasEditOptions(options)
    ? mountPatchFromOptions(options)
    : await promptForMountPatch(config, mountName);

  const nextConfig = editMountInConfig(config, mountName, patch);
  await saveConfig(configPath, nextConfig);
  console.log(chalk.green(`Mount ${mountName} updated in ${configPath}`));
  console.log(chalk.dim('Restart mvmt for the running server to load mount changes. Run `mvmt reindex` to rebuild the index.'));
}

export async function removeMount(name: string | undefined, options: MountCommandOptions = {}): Promise<void> {
  const configPath = resolveMountsConfigPath(options.config);
  const config = loadConfig(configPath);
  const mountName = name ?? await promptForMountName(config, 'Remove which mount?');
  const ok = await confirm({
    message: `Remove mount ${mountName}? Client permissions that reference it will become invalid.`,
    default: false,
  });
  if (!ok) {
    console.log(chalk.yellow('Mount config unchanged.'));
    return;
  }

  const nextConfig = removeMountFromConfig(config, mountName);
  await saveConfig(configPath, nextConfig);
  console.log(chalk.green(`Mount ${mountName} removed from ${configPath}`));
  console.log(chalk.dim('Restart mvmt for the running server to unload mount changes. Run `mvmt reindex` to rebuild the index.'));
}

export function printMounts(config: MvmtConfig): void {
  console.log(chalk.bold('Mounts'));
  if (config.mounts.length === 0) {
    console.log(`  ${chalk.dim('none')}`);
    return;
  }

  for (const mount of config.mounts) {
    const state = mount.enabled === false ? chalk.dim('disabled') : chalk.green('enabled');
    const access = mount.writeAccess ? chalk.yellow('read/write') : chalk.dim('read-only');
    console.log(`  ${mount.name.padEnd(16)} ${state}  ${access}  ${mount.path} -> ${mount.root}`);
    if (mount.description) console.log(`    description: ${mount.description}`);
    if (mount.guidance) console.log(`    guidance: ${mount.guidance}`);
    if (mount.exclude.length > 0) console.log(`    exclude: ${mount.exclude.join(', ')}`);
    if (mount.protect.length > 0) console.log(`    protect: ${mount.protect.join(', ')}`);
  }
}

export function addMountToConfig(config: MvmtConfig, mountInput: MountInput): MvmtConfig {
  if (config.mounts.some((mount) => mount.name === mountInput.name)) {
    throw new Error(`Mount already exists: ${mountInput.name}`);
  }
  const mount = normalizeMountInput(mountInput);
  if (config.mounts.some((candidate) => candidate.path === mount.path)) {
    throw new Error(`Mount path already exists: ${mount.path}`);
  }
  return { ...config, mounts: [...config.mounts, mount] };
}

export function editMountInConfig(config: MvmtConfig, name: string, patch: Partial<MountInput>): MvmtConfig {
  const index = config.mounts.findIndex((mount) => mount.name === name);
  if (index < 0) throw new Error(`Unknown mount: ${name}`);
  const current = config.mounts[index];
  const updated = normalizeMountInput({
    name: current.name,
    root: patch.root ?? current.root,
    path: patch.path ?? current.path,
    writeAccess: patch.writeAccess ?? current.writeAccess,
    description: patch.description ?? current.description,
    guidance: patch.guidance ?? current.guidance,
    exclude: patch.exclude ?? current.exclude,
    protect: patch.protect ?? current.protect,
    enabled: patch.enabled ?? current.enabled,
  });
  if (config.mounts.some((mount, mountIndex) => mountIndex !== index && mount.path === updated.path)) {
    throw new Error(`Mount path already exists: ${updated.path}`);
  }
  return {
    ...config,
    mounts: [
      ...config.mounts.slice(0, index),
      updated,
      ...config.mounts.slice(index + 1),
    ],
  };
}

export function removeMountFromConfig(config: MvmtConfig, name: string): MvmtConfig {
  if (!config.mounts.some((mount) => mount.name === name)) {
    throw new Error(`Unknown mount: ${name}`);
  }
  assertMountNotReferenced(config, name);
  return { ...config, mounts: config.mounts.filter((mount) => mount.name !== name) };
}

export async function promptAndAddMount(config: MvmtConfig): Promise<MvmtConfig | undefined> {
  const mount = await promptForMountInput(config);
  return addMountToConfig(config, mount);
}

export async function promptAndEditMount(config: MvmtConfig): Promise<MvmtConfig | undefined> {
  if (config.mounts.length === 0) {
    console.log(chalk.yellow('No mounts configured.'));
    return undefined;
  }
  const name = await promptForMountName(config, 'Edit which mount?');
  const patch = await promptForMountPatch(config, name);
  return editMountInConfig(config, name, patch);
}

export async function promptAndRemoveMount(config: MvmtConfig): Promise<MvmtConfig | undefined> {
  if (config.mounts.length === 0) {
    console.log(chalk.yellow('No mounts configured.'));
    return undefined;
  }
  const name = await promptForMountName(config, 'Remove which mount?');
  const ok = await confirm({ message: `Remove mount ${name}?`, default: false });
  return ok ? removeMountFromConfig(config, name) : undefined;
}

function resolveMountsConfigPath(configPath?: string): string {
  return configPath ? resolveSetupPath(configPath) : getConfigPath();
}

function normalizeMountInput(inputValue: MountInput): LocalFolderMountConfig {
  return LocalFolderMountSchema.parse({
    name: inputValue.name,
    type: 'local_folder',
    path: normalizeMountPath(inputValue.path ?? `/${inputValue.name}`),
    root: resolveSetupPath(inputValue.root),
    ...(inputValue.description !== undefined ? { description: inputValue.description } : {}),
    ...(inputValue.guidance !== undefined ? { guidance: inputValue.guidance } : {}),
    ...(inputValue.exclude ? { exclude: inputValue.exclude } : {}),
    ...(inputValue.protect ? { protect: inputValue.protect } : {}),
    writeAccess: inputValue.writeAccess,
    enabled: inputValue.enabled ?? true,
  });
}

function mountInputFromOptions(name: string, root: string, options: AddMountOptions): MountInput {
  return {
    name,
    root,
    ...(options.mountPath !== undefined ? { path: options.mountPath } : {}),
    writeAccess: Boolean(options.write),
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.guidance !== undefined ? { guidance: options.guidance } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(options.protect ? { protect: options.protect } : {}),
    enabled: !options.disabled,
  };
}

function mountPatchFromOptions(options: EditMountOptions): Partial<MountInput> {
  return {
    ...(options.root ? { root: options.root } : {}),
    ...(options.mountPath !== undefined ? { path: options.mountPath } : {}),
    ...(options.write ? { writeAccess: true } : {}),
    ...(options.readOnly ? { writeAccess: false } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.guidance !== undefined ? { guidance: options.guidance } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(options.protect ? { protect: options.protect } : {}),
    ...(options.enable ? { enabled: true } : {}),
    ...(options.disable ? { enabled: false } : {}),
  };
}

async function promptForMountInput(config: MvmtConfig): Promise<MountInput> {
  const name = await input({
    message: 'Mount name:',
    validate: (value) => {
      const trimmed = value.trim();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) return 'Use lowercase letters, numbers, dash, or underscore';
      if (config.mounts.some((mount) => mount.name === trimmed)) return `Mount already exists: ${trimmed}`;
      return true;
    },
  });
  const root = await input({
    message: 'Local folder root:',
    validate: (value) => value.trim().length > 0 ? true : 'Enter a folder path',
  });
  const mountPath = await input({
    message: 'Mount path:',
    default: `/${name.trim()}`,
    validate: (value) => validateMountPathInput(value, config),
  });
  const writeAccess = await confirm({
    message: 'Allow write/remove in this mount?',
    default: false,
  });
  const description = await input({
    message: 'Description for agents (optional):',
    default: '',
  });
  const guidance = await input({
    message: 'Mount-specific instructions for agents (optional):',
    default: '',
  });
  const exclude = splitPatterns(await input({
    message: 'Exclude patterns (comma-separated):',
    default: '.git/**, node_modules/**, .claude/**',
  }));
  const protect = splitPatterns(await input({
    message: 'Protected write/remove patterns (comma-separated):',
    default: '.env, .env.*, .claude/**',
  }));
  return {
    name: name.trim(),
    root: root.trim(),
    path: mountPath.trim(),
    writeAccess,
    description: description.trim(),
    guidance: guidance.trim(),
    exclude,
    protect,
    enabled: true,
  };
}

async function promptForMountPatch(config: MvmtConfig, name: string): Promise<Partial<MountInput>> {
  const current = config.mounts.find((mount) => mount.name === name);
  if (!current) throw new Error(`Unknown mount: ${name}`);
  const root = await input({ message: 'Local folder root:', default: current.root });
  const mountPath = await input({
    message: 'Mount path:',
    default: current.path,
    validate: (value) => validateMountPathInput(value, config, name),
  });
  const writeAccess = await confirm({
    message: 'Allow write/remove in this mount?',
    default: current.writeAccess,
  });
  const enabled = await confirm({
    message: 'Enable this mount?',
    default: current.enabled,
  });
  const description = await input({
    message: 'Description for agents:',
    default: current.description,
  });
  const guidance = await input({
    message: 'Mount-specific instructions for agents:',
    default: current.guidance,
  });
  const exclude = splitPatterns(await input({
    message: 'Exclude patterns (comma-separated):',
    default: current.exclude.join(', '),
  }));
  const protect = splitPatterns(await input({
    message: 'Protected write/remove patterns (comma-separated):',
    default: current.protect.join(', '),
  }));
  return { root: root.trim(), path: mountPath.trim(), writeAccess, enabled, description: description.trim(), guidance: guidance.trim(), exclude, protect };
}

async function promptForMountName(config: MvmtConfig, message: string): Promise<string> {
  if (config.mounts.length === 0) throw new Error('No mounts configured.');
  return select({
    message,
    choices: config.mounts.map((mount) => ({
      name: `${mount.name} (${mount.path} -> ${mount.root})`,
      value: mount.name,
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

function hasEditOptions(options: EditMountOptions): boolean {
  return Boolean(
    options.root ||
    options.mountPath !== undefined ||
    options.write ||
    options.readOnly ||
    options.description !== undefined ||
    options.guidance !== undefined ||
    options.exclude ||
    options.protect ||
    options.enable ||
    options.disable
  );
}

function assertMountNotReferenced(config: MvmtConfig, name: string): void {
  const mount = config.mounts.find((candidate) => candidate.name === name);
  const mountPath = mount?.path;
  for (const client of config.clients ?? []) {
    if (mountPath && client.permissions.some((permission) => (
      permission.path === mountPath || permission.path.startsWith(`${mountPath}/`)
    ))) {
      throw new Error(`Mount ${name} is still referenced by client ${client.id}`);
    }
  }

  const semantic = config.semanticTools;
  if (semantic?.searchPersonalContext?.sourceIds.includes(name)) {
    throw new Error(`Mount ${name} is still referenced by semanticTools.searchPersonalContext`);
  }
  if (semantic?.readContextItem?.sourceIds.includes(name)) {
    throw new Error(`Mount ${name} is still referenced by semanticTools.readContextItem`);
  }
}

function normalizeMountPath(value: string): string {
  const trimmed = stripTrailingSlashes(normalizePathSeparators(value.trim()));
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash === '' ? '/' : withSlash;
}

function validateMountPathInput(value: string, config: MvmtConfig, currentName?: string): true | string {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a mount path such as /notes';
  const normalized = normalizeMountPath(trimmed);
  if (!/^\/[A-Za-z0-9._~/-]+$/.test(normalized)) return 'Use an absolute path such as /notes or /desktop/projects';
  if (normalized === '/') return 'Mount path cannot be /';
  if (config.mounts.some((mount) => mount.name !== currentName && mount.path === normalized)) {
    return `Mount path already exists: ${normalized}`;
  }
  return true;
}
