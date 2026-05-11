import chalk from 'chalk';
import fsp from 'fs/promises';
import path from 'path';
import { configExists, getConfigPath, loadConfig, parseConfig, saveConfig } from '../config/loader.js';
import { MvmtConfig } from '../config/schema.js';
import { resolveSetupPath } from '../connectors/setup-paths.js';
import { MountRegistry, normalizeVirtualPath } from '../context/mount-registry.js';
import { addMountToConfig, MountInput } from './mounts.js';
import { createLease, DEFAULT_LEASE_TTL, defaultLeasesPath, leaseUnavailableReason, listLeases, revokeLease } from '../lease/store.js';
import { parseTokenTtl } from '../utils/token-ttl.js';
import { normalizeTunnelBaseUrl } from '../utils/tunnel.js';

export interface LeaseCommandOptions {
  config?: string;
  json?: boolean;
  leaseStorePath?: string;
}

export interface CreateLeaseOptions extends LeaseCommandOptions {
  label?: string;
  expires?: string;
  ttl?: string;
}

export async function listFolderLeases(options: LeaseCommandOptions = {}): Promise<void> {
  const leases = listLeases(resolveLeaseStorePath(options));
  if (options.json) {
    console.log(JSON.stringify({ leases }, null, 2));
    return;
  }

  console.log(chalk.bold('Folder leases'));
  if (leases.length === 0) {
    console.log(`  ${chalk.dim('none')}`);
    return;
  }
  for (const lease of leases) {
    const reason = leaseUnavailableReason(lease);
    const state = reason ? chalk.yellow(reason) : chalk.green('active');
    console.log(`  ${lease.id.padEnd(16)} ${state}  ${lease.label}  ${lease.path}  expires ${lease.expiresAt ?? 'never'}  downloads ${lease.downloadCount}`);
  }
}

export async function createFolderLease(inputPath: string | undefined, options: CreateLeaseOptions = {}): Promise<void> {
  if (!inputPath) throw new Error('Folder is required. Example: mvmt lease create ~/Documents/Taxes --label "Sarah - tax docs"');
  const label = options.label?.trim();
  if (!label) throw new Error('Label is required. Example: --label "Sarah - tax docs"');

  const configPath = options.config ? resolveSetupPath(options.config) : getConfigPath();
  const config = configExists(configPath) ? loadConfig(configPath) : parseConfig({ version: 1 });
  const prepared = await prepareLeasePath(config, inputPath, label);
  if (prepared.config !== config) await saveConfig(configPath, prepared.config);

  const ttl = parseTokenTtl(options.expires ?? options.ttl ?? DEFAULT_LEASE_TTL);
  const created = createLease(resolveLeaseStorePath(options), {
    label,
    path: prepared.leasePath,
    expiresAt: ttl.expiresAt,
  });
  const url = leaseUrl(prepared.config, created.record.id, created.token);

  if (options.json) {
    console.log(JSON.stringify({ lease: { ...created.record, url } }, null, 2));
    return;
  }

  console.log(chalk.green('Folder lease created'));
  console.log(`  Label: ${created.record.label}`);
  console.log(`  Folder: ${created.record.path}`);
  console.log(`  Expires: ${created.record.expiresAt ?? 'never'}${options.expires || options.ttl ? '' : ` (${DEFAULT_LEASE_TTL} default)`}`);
  if (prepared.addedMount) console.log(chalk.dim(`  Added read-only mount: ${prepared.addedMount.name} -> ${prepared.addedMount.root}`));
  console.log(`  URL: ${url}`);
}

export async function revokeFolderLease(id: string | undefined, options: LeaseCommandOptions = {}): Promise<void> {
  if (!id) throw new Error('Lease id is required.');
  if (!revokeLease(resolveLeaseStorePath(options), id)) throw new Error(`Unknown lease: ${id}`);
  console.log(chalk.green(`Folder lease ${id} revoked`));
}

async function prepareLeasePath(
  config: MvmtConfig,
  inputPath: string,
  label: string,
): Promise<{ config: MvmtConfig; leasePath: string; addedMount?: MountInput }> {
  const resolvedLocalPath = resolveSetupPath(inputPath);
  const localStat = await statIfExists(resolvedLocalPath);
  if (localStat?.isDirectory()) return prepareLocalFolderLeasePath(config, resolvedLocalPath, label);
  if (inputPath.trim().startsWith('/')) {
    const leasePath = normalizeVirtualPath(inputPath);
    const resolved = new MountRegistry(config.mounts).resolve(leasePath);
    const stat = await fsp.stat(resolved.realPath);
    if (!stat.isDirectory()) throw new Error(`${leasePath} is not a mounted folder`);
    return { config, leasePath };
  }
  throw new Error(`Folder not found: ${resolvedLocalPath}`);
}

async function prepareLocalFolderLeasePath(
  config: MvmtConfig,
  root: string,
  label: string,
): Promise<{ config: MvmtConfig; leasePath: string; addedMount?: MountInput }> {
  const realRoot = await fsp.realpath(root);
  for (const mount of config.mounts) {
    try {
      const mountRoot = await fsp.realpath(resolveSetupPath(mount.root));
      if (mount.enabled !== false && mountRoot === realRoot) return { config, leasePath: mount.path };
    } catch {
      // Ignore stale mount roots while creating a lease for a valid folder.
    }
  }

  const name = uniqueMountName(config, `lease-${slugFromPath(realRoot)}`);
  const mountPath = uniqueMountPath(config, `/${name}`);
  const mount: MountInput = {
    name,
    root,
    path: mountPath,
    writeAccess: false,
    description: `Folder lease source: ${label}`,
    guidance: '',
    enabled: true,
  };
  return { config: addMountToConfig(config, mount), leasePath: mountPath, addedMount: mount };
}

async function statIfExists(inputPath: string): Promise<Awaited<ReturnType<typeof fsp.stat>> | undefined> {
  try {
    return await fsp.stat(inputPath);
  } catch {
    return undefined;
  }
}

function resolveLeaseStorePath(options: LeaseCommandOptions): string {
  return options.leaseStorePath ?? defaultLeasesPath();
}

function leaseUrl(config: MvmtConfig, id: string, token: string): string {
  const base = config.server.access === 'tunnel' && config.server.tunnel?.url
    ? normalizeTunnelBaseUrl(config.server.tunnel.url)
    : `http://127.0.0.1:${config.server.port}`;
  const url = new URL(`/lease/${id}`, base);
  url.searchParams.set('token', token);
  return url.toString();
}

function uniqueMountName(config: MvmtConfig, baseName: string): string {
  if (!config.mounts.some((mount) => mount.name === baseName)) return baseName;
  for (let index = 2; ; index += 1) {
    const candidate = `${baseName}-${index}`;
    if (!config.mounts.some((mount) => mount.name === candidate)) return candidate;
  }
}

function uniqueMountPath(config: MvmtConfig, basePath: string): string {
  if (!config.mounts.some((mount) => mount.path === basePath)) return basePath;
  for (let index = 2; ; index += 1) {
    const candidate = `${basePath}-${index}`;
    if (!config.mounts.some((mount) => mount.path === candidate)) return candidate;
  }
}

function slugFromPath(inputPath: string): string {
  const leaf = path.basename(inputPath) || 'folder';
  return leaf
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'folder';
}
