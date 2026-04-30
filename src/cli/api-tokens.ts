import crypto from 'crypto';
import { confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { getConfigPath, loadConfig, saveConfig } from '../config/loader.js';
import { hashApiToken } from '../utils/api-token-hash.js';
import { defaultTokenTtl, formatTokenExpiry, parseTokenTtl } from './token-ttl.js';
import {
  ClientConfig,
  ConfigSchema,
  LocalFolderMountConfig,
  MvmtConfig,
  PermissionConfig,
} from '../config/schema.js';
import { resolveSetupPath } from '../connectors/setup-paths.js';

const API_TOKEN_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface ApiTokensCommandOptions {
  config?: string;
  json?: boolean;
}

export interface AddApiTokenOptions extends ApiTokensCommandOptions {
  name?: string;
  description?: string;
  ttl?: string;
  read?: string[];
  write?: string[];
}

export interface EditApiTokenOptions extends AddApiTokenOptions {}

export interface RemoveApiTokenOptions extends ApiTokensCommandOptions {
  yes?: boolean;
}

export interface RotateApiTokenOptions extends ApiTokensCommandOptions {}

export type ApiTokenPermissionMode = 'read' | 'write';

export interface ApiTokenPermissionInput {
  mount: string;
  mode: ApiTokenPermissionMode;
}

export interface ApiTokenInput {
  id: string;
  name?: string;
  description?: string;
  ttl?: string;
  now?: number;
  permissions: ApiTokenPermissionInput[];
  plaintextToken?: string;
}

export interface ApiTokenUpdateResult {
  config: MvmtConfig;
  created: boolean;
  plaintextToken?: string;
  client: ClientConfig;
}

export async function listApiTokens(options: ApiTokensCommandOptions = {}): Promise<void> {
  const config = loadConfig(resolveApiTokensConfigPath(options.config));
  printApiTokens(config, { json: Boolean(options.json) });
}

export function printApiTokens(config: MvmtConfig, options: { json?: boolean } = {}): void {
  const tokens = tokenClients(config);
  if (options.json) {
    console.log(JSON.stringify({ tokens: tokens.map(toApiTokenSummary) }, null, 2));
    return;
  }

  console.log(chalk.bold('Tokens'));
  console.log('');
  if (tokens.length === 0) {
    console.log(`    ${chalk.dim('none')}`);
    console.log(chalk.dim('    Add one with `mvmt token add`.'));
    return;
  }

  for (const client of tokens) {
    console.log(`    ${client.id}`);
    console.log(`      name: ${client.name}`);
    if (client.description) console.log(`      description: ${client.description}`);
    console.log(`      expires: ${formatTokenExpiry(client.expiresAt)}`);
    if (client.permissions.length === 0) {
      console.log(`      ${chalk.dim('no mount permissions')}`);
    } else {
      for (const permission of client.permissions) {
        console.log(`      can: ${permission.actions.join(', ')}`);
        console.log(`      path: ${permission.path}`);
      }
    }
    console.log(`      ${chalk.dim('token: hidden, rotate to replace')}`);
  }
}

export async function addApiToken(id: string | undefined, options: AddApiTokenOptions = {}): Promise<void> {
  try {
    const configPath = resolveApiTokensConfigPath(options.config);
    const config = loadConfig(configPath);
    const inputValue = hasPermissionOptions(options)
      ? apiTokenInputFromOptions(config, id, options)
      : await promptForApiTokenInput(config, id, options);

    const result = addApiTokenToConfig(config, inputValue);
    await saveConfig(configPath, result.config);
    printApiTokenSaved(configPath, result);
    console.log(chalk.dim('Restart mvmt for the running server to load API-token changes.'));
  } catch (err) {
    printApiTokenCommandError(err);
  }
}

export async function editApiToken(id: string | undefined, options: EditApiTokenOptions = {}): Promise<void> {
  try {
    const configPath = resolveApiTokensConfigPath(options.config);
    const config = loadConfig(configPath);
    const tokenId = id ?? await promptForApiTokenId(config, 'Edit which API token?');
    const inputValue = hasEditOptions(options)
      ? apiTokenInputFromOptions(config, tokenId, options, { requirePermissions: false })
      : await promptForApiTokenInput(config, tokenId, options);

    const result = editApiTokenInConfig(config, tokenId, inputValue);
    await saveConfig(configPath, result.config);
    printApiTokenSaved(configPath, result);
    console.log(chalk.dim('Restart mvmt for the running server to load API-token changes.'));
  } catch (err) {
    printApiTokenCommandError(err);
  }
}

export async function removeApiToken(id: string | undefined, options: RemoveApiTokenOptions = {}): Promise<void> {
  try {
    const configPath = resolveApiTokensConfigPath(options.config);
    const config = loadConfig(configPath);
    const tokenId = id ?? await promptForApiTokenId(config, 'Remove which API token?');
    const ok = options.yes ? true : await confirm({
      message: `Remove API token ${tokenId}?`,
      default: false,
    });
    if (!ok) {
      console.log(chalk.yellow('API token config unchanged.'));
      return;
    }

    const nextConfig = removeApiTokenFromConfig(config, tokenId);
    await saveConfig(configPath, nextConfig);
    console.log(chalk.green(`API token ${tokenId} removed from ${configPath}`));
    console.log(chalk.dim('Restart mvmt for the running server to unload API-token changes.'));
  } catch (err) {
    printApiTokenCommandError(err);
  }
}

export async function rotateApiToken(id: string | undefined, options: RotateApiTokenOptions = {}): Promise<void> {
  try {
    const configPath = resolveApiTokensConfigPath(options.config);
    const config = loadConfig(configPath);
    const tokenId = id ?? await promptForApiTokenId(config, 'Rotate which API token?');
    const result = rotateApiTokenInConfig(config, tokenId);
    await saveConfig(configPath, result.config);
    printApiTokenSaved(configPath, result);
    console.log(chalk.dim('Restart mvmt for the running server to load API-token changes.'));
  } catch (err) {
    printApiTokenCommandError(err);
  }
}

export async function promptAndAddApiToken(config: MvmtConfig): Promise<ApiTokenUpdateResult | undefined> {
  const inputValue = await promptForApiTokenInput(config, undefined, {});
  return addApiTokenToConfig(config, inputValue);
}

export async function promptAndEditApiToken(config: MvmtConfig): Promise<ApiTokenUpdateResult | undefined> {
  const tokenId = await promptForApiTokenId(config, 'Edit which API token?');
  const inputValue = await promptForApiTokenInput(config, tokenId, {});
  return editApiTokenInConfig(config, tokenId, inputValue);
}

export async function promptAndRemoveApiToken(config: MvmtConfig): Promise<MvmtConfig | undefined> {
  const tokenId = await promptForApiTokenId(config, 'Remove which API token?');
  const ok = await confirm({ message: `Remove API token ${tokenId}?`, default: false });
  return ok ? removeApiTokenFromConfig(config, tokenId) : undefined;
}

export function addApiTokenToConfig(config: MvmtConfig, inputValue: ApiTokenInput): ApiTokenUpdateResult {
  const id = normalizeApiTokenId(inputValue.id);
  const existing = config.clients?.find((client) => client.id === id);
  if (existing && existing.auth.type !== 'token') {
    throw new Error(`Client id ${id} already exists and is not an API token.`);
  }

  const name = (inputValue.name ?? existing?.name ?? id).trim();
  if (!name) throw new Error('API token display name cannot be empty.');
  const description = (inputValue.description ?? existing?.description ?? '').trim();
  const expiresAt = resolveExpiresAt(inputValue, existing);

  const permissions = applyPermissionInputs(
    config,
    existing?.permissions ?? [],
    inputValue.permissions,
  );
  const created = !existing;
  const plaintextToken = created ? (inputValue.plaintextToken ?? generateApiToken()) : undefined;
  const nextClient: ClientConfig = {
    id,
    name,
    description,
    ...(expiresAt ? { expiresAt } : {}),
    auth: existing?.auth ?? {
      type: 'token',
      tokenHash: hashApiToken(plaintextToken!),
    },
    rawToolsEnabled: existing?.rawToolsEnabled ?? false,
    permissions,
  };
  const clients = [
    ...(config.clients ?? []).filter((client) => client.id !== id),
    nextClient,
  ];
  const nextConfig = ConfigSchema.parse({ ...config, clients });
  return { config: nextConfig, created, plaintextToken, client: nextClient };
}

export function editApiTokenInConfig(
  config: MvmtConfig,
  id: string,
  inputValue: ApiTokenInput,
): ApiTokenUpdateResult {
  const tokenId = normalizeApiTokenId(id);
  const existing = config.clients?.find((client) => client.id === tokenId);
  if (!existing || existing.auth.type !== 'token') throw new Error(`Unknown API token: ${tokenId}`);
  const name = (inputValue.name ?? existing.name).trim();
  if (!name) throw new Error('API token display name cannot be empty.');
  const description = (inputValue.description ?? existing.description ?? '').trim();
  const expiresAt = resolveExpiresAt(inputValue, existing);
  const permissions = inputValue.permissions.length > 0
    ? applyPermissionInputs(config, [], inputValue.permissions)
    : existing.permissions;
  const nextClient: ClientConfig = {
    id: tokenId,
    name,
    description,
    ...(expiresAt ? { expiresAt } : {}),
    auth: existing.auth,
    rawToolsEnabled: existing.rawToolsEnabled,
    permissions,
  };
  const clients = [
    ...(config.clients ?? []).filter((client) => client.id !== tokenId),
    nextClient,
  ];
  const nextConfig = ConfigSchema.parse({ ...config, clients });
  return { config: nextConfig, created: false, client: nextClient };
}

export function rotateApiTokenInConfig(
  config: MvmtConfig,
  id: string,
  plaintextToken = generateApiToken(),
): ApiTokenUpdateResult {
  const tokenId = normalizeApiTokenId(id);
  const existing = config.clients?.find((client) => client.id === tokenId);
  if (!existing || existing.auth.type !== 'token') throw new Error(`Unknown API token: ${tokenId}`);
  const nextClient: ClientConfig = {
    ...existing,
    auth: {
      type: 'token',
      tokenHash: hashApiToken(plaintextToken),
    },
  };
  const clients = [
    ...(config.clients ?? []).filter((client) => client.id !== tokenId),
    nextClient,
  ];
  const nextConfig = ConfigSchema.parse({ ...config, clients });
  return { config: nextConfig, created: false, plaintextToken, client: nextClient };
}

export function removeApiTokenFromConfig(config: MvmtConfig, id: string): MvmtConfig {
  const tokenId = normalizeApiTokenId(id);
  const current = config.clients ?? [];
  const target = current.find((client) => client.id === tokenId);
  if (!target || target.auth.type !== 'token') throw new Error(`Unknown API token: ${tokenId}`);
  const clients = current.filter((client) => client.id !== tokenId);
  return ConfigSchema.parse({
    ...config,
    ...(clients.length > 0 ? { clients } : { clients: undefined }),
  });
}

function apiTokenInputFromOptions(
  config: MvmtConfig,
  id: string | undefined,
  options: AddApiTokenOptions,
  parseOptions: { requirePermissions?: boolean } = {},
): ApiTokenInput {
  if (!id) throw new Error('API token id is required when using --read or --write.');
  const permissions: ApiTokenPermissionInput[] = [
    ...(options.read ?? []).map((mount) => ({ mount, mode: 'read' as const })),
    ...(options.write ?? []).map((mount) => ({ mount, mode: 'write' as const })),
  ];
  if (permissions.length === 0 && parseOptions.requirePermissions !== false) {
    throw new Error('Add at least one permission with --read <mount> or --write <mount>.');
  }
  assertMountsConfigured(config);
  return {
    id,
    name: options.name,
    description: options.description,
    ttl: options.ttl,
    permissions,
  };
}

async function promptForApiTokenInput(
  config: MvmtConfig,
  id: string | undefined,
  options: AddApiTokenOptions,
): Promise<ApiTokenInput> {
  assertMountsConfigured(config);
  const tokenId = id ? normalizeApiTokenId(id) : await input({
    message: 'API token id:',
    validate: validateApiTokenId,
  });
  const existing = config.clients?.find((client) => client.id === tokenId);
  if (existing && existing.auth.type !== 'token') {
    throw new Error(`Client id ${tokenId} already exists and is not an API token.`);
  }
  const name = options.name ?? await input({
    message: 'Display name:',
    default: existing?.name ?? tokenId,
    validate: (value) => value.trim().length > 0 ? true : 'Enter a display name',
  });
  const description = options.description ?? await input({
    message: 'Description (optional):',
    default: existing?.description ?? '',
  });
  const ttl = options.ttl ?? await input({
    message: 'TTL (examples: 30m, 7d, 30d, never):',
    default: existing?.expiresAt ? '30d' : defaultTokenTtl(),
    validate: (value) => {
      try {
        parseTokenTtl(value);
        return true;
      } catch (err) {
        return err instanceof Error ? err.message : 'Invalid TTL';
      }
    },
  });
  const permissions = await promptForPermissionInputs(config, existing?.permissions ?? []);
  return { id: tokenId, name, description, ttl, permissions };
}

async function promptForPermissionInputs(
  config: MvmtConfig,
  currentPermissions: readonly PermissionConfig[],
): Promise<ApiTokenPermissionInput[]> {
  const inputs: ApiTokenPermissionInput[] = [];
  let addMore = true;
  while (addMore) {
    const mount = await select<LocalFolderMountConfig>({
      message: 'Grant access to which mount?',
      choices: enabledMounts(config).map((candidate) => ({
        name: `${candidate.path} (${candidate.name}, ${candidate.writeAccess ? 'read/write mount' : 'read-only mount'})`,
        value: candidate,
      })),
    });
    const existing = findPermissionForMount(currentPermissions, mount);
    if (existing) {
      const update = await confirm({
        message: `Permission already exists for ${mount.path}: ${existing.actions.join(', ')}. Update it?`,
        default: true,
      });
      if (!update) {
        addMore = await confirm({ message: 'Add another mount permission?', default: false });
        continue;
      }
    }
    const mode = await promptForPermissionMode(mount);
    inputs.push({ mount: mount.name, mode });
    addMore = await confirm({ message: 'Add another mount permission?', default: false });
  }
  if (inputs.length === 0) throw new Error('API token needs at least one mount permission.');
  return inputs;
}

async function promptForPermissionMode(mount: LocalFolderMountConfig): Promise<ApiTokenPermissionMode> {
  if (!mount.writeAccess) {
    console.log(chalk.dim(`${mount.path} is a read-only mount. API token access is limited to search/read.`));
    return 'read';
  }
  return select<ApiTokenPermissionMode>({
    message: `Permission for ${mount.path}:`,
    choices: [
      { name: 'read/search only', value: 'read' },
      { name: 'read/search/write/remove', value: 'write' },
    ],
  });
}

function applyPermissionInputs(
  config: MvmtConfig,
  currentPermissions: readonly PermissionConfig[],
  inputs: readonly ApiTokenPermissionInput[],
): PermissionConfig[] {
  if (inputs.length === 0) throw new Error('API token needs at least one mount permission.');
  const next = [...currentPermissions];
  for (const inputValue of inputs) {
    const mount = resolveMount(config, inputValue.mount);
    const actions = actionsForMountPermission(mount, inputValue.mode);
    const permission: PermissionConfig = {
      path: permissionPathForMount(mount),
      actions,
    };
    const existingIndex = next.findIndex((candidate) => permissionTargetsMount(candidate, mount));
    if (existingIndex >= 0) {
      next[existingIndex] = permission;
    } else {
      next.push(permission);
    }
  }
  return next;
}

function actionsForMountPermission(
  mount: LocalFolderMountConfig,
  mode: ApiTokenPermissionMode,
): PermissionConfig['actions'] {
  if (mode === 'write' && !mount.writeAccess) {
    throw new Error(`Mount ${mount.path} is read-only; API token cannot be granted write/remove.`);
  }
  return mode === 'write' ? ['search', 'read', 'write'] : ['search', 'read'];
}

function resolveMount(config: MvmtConfig, mountRef: string): LocalFolderMountConfig {
  const normalizedRef = mountRef.trim();
  const mount = enabledMounts(config).find((candidate) => (
    candidate.name === normalizedRef || candidate.path === normalizedRef
  ));
  if (!mount) throw new Error(`Unknown enabled mount: ${mountRef}`);
  return mount;
}

function findPermissionForMount(
  permissions: readonly PermissionConfig[],
  mount: LocalFolderMountConfig,
): PermissionConfig | undefined {
  return permissions.find((permission) => permissionTargetsMount(permission, mount));
}

function permissionTargetsMount(permission: PermissionConfig, mount: LocalFolderMountConfig): boolean {
  const subtree = permissionPathForMount(mount);
  return permission.path === mount.path || permission.path === subtree;
}

function permissionPathForMount(mount: LocalFolderMountConfig): string {
  return `${mount.path}/**`;
}

function enabledMounts(config: MvmtConfig): LocalFolderMountConfig[] {
  return config.mounts.filter((mount) => mount.enabled !== false);
}

function assertMountsConfigured(config: MvmtConfig): void {
  if (enabledMounts(config).length === 0) {
    throw new Error('No enabled mounts. Add one with `mvmt mounts add <name> <folder>` first.');
  }
}

function promptForApiTokenId(config: MvmtConfig, message: string): Promise<string> {
  const tokens = tokenClients(config);
  if (tokens.length === 0) throw new Error('No API tokens configured.');
  return select({
    message,
    choices: tokens.map((client) => ({
      name: `${client.id} (${client.name})`,
      value: client.id,
    })),
  });
}

function tokenClients(config: MvmtConfig): ClientConfig[] {
  return (config.clients ?? []).filter((client) => client.auth.type === 'token');
}

function toApiTokenSummary(client: ClientConfig): Record<string, unknown> {
  return {
    id: client.id,
    name: client.name,
    description: client.description,
    expiresAt: client.expiresAt,
    permissions: client.permissions,
  };
}

export function printApiTokenSaved(configPath: string, result: ApiTokenUpdateResult): void {
  const action = result.created ? 'created' : 'updated';
  console.log(chalk.green(`API token ${result.client.id} ${action} in ${configPath}`));
  for (const permission of result.client.permissions) {
    console.log(`  ${permission.path}  ${permission.actions.join(', ')}`);
  }
  console.log(`  expires: ${formatTokenExpiry(result.client.expiresAt)}`);
  if (result.plaintextToken) {
    console.log('');
    console.log(chalk.bold('API token (shown once)'));
    console.log(`  id: ${result.client.id}`);
    console.log(`  token: ${result.plaintextToken}`);
    console.log('');
    console.log(chalk.dim('Use it as: Authorization: Bearer <token>'));
    console.log(chalk.dim('Paste this token into the mvmt OAuth approval page when a client asks you to sign in.'));
  } else {
    console.log(chalk.dim('Existing token value was not changed.'));
  }
}

function hasPermissionOptions(options: AddApiTokenOptions): boolean {
  return Boolean((options.read?.length ?? 0) > 0 || (options.write?.length ?? 0) > 0);
}

function hasEditOptions(options: EditApiTokenOptions): boolean {
  return hasPermissionOptions(options)
    || options.name !== undefined
    || options.description !== undefined
    || options.ttl !== undefined;
}

function resolveExpiresAt(inputValue: ApiTokenInput, existing?: ClientConfig): string | undefined {
  if (inputValue.ttl !== undefined) {
    return parseTokenTtl(inputValue.ttl, inputValue.now).expiresAt;
  }
  if (existing) return existing.expiresAt;
  return parseTokenTtl(defaultTokenTtl(), inputValue.now).expiresAt;
}

function normalizeApiTokenId(id: string): string {
  const trimmed = id.trim();
  const valid = validateApiTokenId(trimmed);
  if (valid !== true) throw new Error(String(valid));
  return trimmed;
}

function validateApiTokenId(value: string): true | string {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter an API token id';
  if (!API_TOKEN_ID_RE.test(trimmed)) {
    return 'Use lowercase letters, numbers, dash, or underscore';
  }
  return true;
}

function generateApiToken(): string {
  return `mvmt_${crypto.randomBytes(32).toString('base64url')}`;
}

function resolveApiTokensConfigPath(configPath?: string): string {
  return configPath ? resolveSetupPath(configPath) : getConfigPath();
}

function printApiTokenCommandError(err: unknown): void {
  console.error(err instanceof Error ? err.message : 'API token command failed.');
  process.exitCode = 1;
}
