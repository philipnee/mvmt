import fsp from 'fs/promises';
import type { Stats } from 'fs';
import path from 'path';
import { LocalFolderMountConfig } from '../config/schema.js';
import { MountRegistry, normalizePathSeparators, toVirtualRelative } from '../context/mount-registry.js';
import { isGloballyDeniedPath, matchesConfiguredOrGlobalPattern, matchesPathPatterns } from '../context/path-policy.js';
import { LeaseRecord } from './store.js';

export interface LeaseFileTarget {
  mountName: string;
  leasePath: string;
  virtualPath: string;
  leaseRelativePath: string;
  realPath: string;
  filename: string;
  size: number;
  mtimeMs: number;
}

export interface LeaseUploadTarget {
  mountName: string;
  leasePath: string;
  virtualPath: string;
  leaseRelativePath: string;
  realPath: string;
  parentRealPath: string;
  filename: string;
}

export interface LeaseDirectoryEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  mtimeMs: number;
}

export interface LeaseDirectoryListing {
  label: string;
  leaseId: string;
  path: string;
  expiresAt?: string;
  entries: LeaseDirectoryEntry[];
}

export async function resolveLeaseFileTarget(
  mounts: readonly LocalFolderMountConfig[],
  lease: LeaseRecord,
  requestPath = '',
): Promise<LeaseFileTarget> {
  const target = await resolveLeaseTarget(mounts, lease, requestPath);
  if (target.stat.isDirectory()) throw new Error(`${target.virtualPath} is a directory`);
  if (!target.stat.isFile()) throw new Error(`${target.virtualPath} is not a file`);
  return {
    mountName: target.mountName,
    leasePath: lease.path,
    virtualPath: target.virtualPath,
    leaseRelativePath: target.leaseRelativePath,
    realPath: target.realPath,
    filename: path.basename(target.virtualPath),
    size: target.stat.size,
    mtimeMs: target.stat.mtimeMs,
  };
}

export async function listLeaseDirectory(
  mounts: readonly LocalFolderMountConfig[],
  lease: LeaseRecord,
  requestPath = '',
): Promise<LeaseDirectoryListing> {
  const target = await resolveLeaseTarget(mounts, lease, requestPath);
  if (!target.stat.isDirectory()) throw new Error(`${target.virtualPath} is not a directory`);
  const dirents = await fsp.readdir(target.realPath, { withFileTypes: true });
  const entries: LeaseDirectoryEntry[] = [];
  for (const dirent of dirents) {
    const childPath = joinLeaseRelativePath(target.leaseRelativePath, dirent.name);
    try {
      const child = await resolveLeaseTarget(mounts, lease, childPath);
      if (!child.stat.isDirectory() && !child.stat.isFile()) continue;
      entries.push({
        name: dirent.name,
        path: `/${child.leaseRelativePath}`,
        type: child.stat.isDirectory() ? 'directory' : 'file',
        size: child.stat.isDirectory() ? 0 : child.stat.size,
        mtimeMs: child.stat.mtimeMs,
      });
    } catch {
      // Hidden, denied, broken, or escaping children stay invisible in listings.
    }
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return {
    label: lease.label,
    leaseId: lease.id,
    path: target.leaseRelativePath ? `/${target.leaseRelativePath}` : '/',
    ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}),
    entries,
  };
}

export async function resolveLeaseUploadTarget(
  mounts: readonly LocalFolderMountConfig[],
  lease: LeaseRecord,
  requestPath: string,
): Promise<LeaseUploadTarget> {
  const registry = new MountRegistry([...mounts]);
  const leaseRoot = registry.resolve(lease.path);
  const leaseRootStat = await fsp.stat(leaseRoot.realPath);
  if (!leaseRootStat.isDirectory()) throw new Error(`${lease.path} is not a directory`);
  if (!leaseRoot.mount.config.writeAccess) throw new Error(`${lease.path} is read-only`);

  const leaseRootRealPath = await fsp.realpath(leaseRoot.realPath);
  const leaseRelativePath = normalizeLeaseRelativePath(requestPath);
  if (!leaseRelativePath) throw new Error('upload path is required');
  const virtualPath = `${stripTrailingSlash(lease.path)}/${leaseRelativePath}`;
  const resolved = registry.resolve(virtualPath);
  const filename = path.basename(resolved.realPath);
  if (!filename || filename === '.' || filename === '..') throw new Error('upload filename is required');

  const policyPath = resolved.relativePath || filename;
  if (matchesConfiguredOrGlobalPattern(policyPath, resolved.mount.config.exclude)) {
    throw new Error(`${resolved.virtualPath} is excluded`);
  }
  if (matchesPathPatterns(policyPath, resolved.mount.config.protect)) {
    throw new Error(`${resolved.virtualPath} is protected`);
  }

  const parentRealPath = await fsp.realpath(path.dirname(resolved.realPath));
  if (!isWithin(leaseRootRealPath, parentRealPath)) {
    throw new Error(`${resolved.virtualPath} escapes lease root`);
  }
  const targetRealPath = path.resolve(parentRealPath, filename);
  if (!isWithin(leaseRootRealPath, targetRealPath)) {
    throw new Error(`${resolved.virtualPath} escapes lease root`);
  }
  if (isGloballyDeniedPath(policyPath, targetRealPath)) {
    throw new Error(`${resolved.virtualPath} is globally denied`);
  }
  try {
    await fsp.lstat(targetRealPath);
    throw new Error(`${resolved.virtualPath} already exists`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  return {
    mountName: resolved.mount.config.name,
    leasePath: lease.path,
    virtualPath: resolved.virtualPath,
    leaseRelativePath,
    realPath: targetRealPath,
    parentRealPath,
    filename,
  };
}

async function resolveLeaseTarget(
  mounts: readonly LocalFolderMountConfig[],
  lease: LeaseRecord,
  requestPath: string,
): Promise<{
  mountName: string;
  virtualPath: string;
  leaseRelativePath: string;
  realPath: string;
  stat: Stats;
}> {
  const registry = new MountRegistry([...mounts]);
  const leaseRoot = registry.resolve(lease.path);
  const leaseRootStat = await fsp.stat(leaseRoot.realPath);
  if (!leaseRootStat.isDirectory()) throw new Error(`${lease.path} is not a directory`);

  const leaseRootRealPath = await fsp.realpath(leaseRoot.realPath);
  const leaseRelativePath = normalizeLeaseRelativePath(requestPath);
  const virtualPath = leaseRelativePath ? `${stripTrailingSlash(lease.path)}/${leaseRelativePath}` : stripTrailingSlash(lease.path);
  const resolved = registry.resolve(virtualPath);
  const policyPath = resolved.relativePath || path.basename(resolved.realPath);
  if (matchesConfiguredOrGlobalPattern(policyPath, resolved.mount.config.exclude)) {
    throw new Error(`${resolved.virtualPath} is excluded`);
  }

  const targetRealPath = await fsp.realpath(resolved.realPath);
  if (!isWithin(leaseRootRealPath, targetRealPath)) {
    throw new Error(`${resolved.virtualPath} escapes lease root`);
  }
  if (isGloballyDeniedPath(policyPath, targetRealPath)) {
    throw new Error(`${resolved.virtualPath} is globally denied`);
  }

  return {
    mountName: resolved.mount.config.name,
    virtualPath: resolved.virtualPath,
    leaseRelativePath,
    realPath: targetRealPath,
    stat: await fsp.stat(targetRealPath),
  };
}

function normalizeLeaseRelativePath(inputPath: string): string {
  const segments = normalizePathSeparators(inputPath).split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) throw new Error('path escapes lease root');
  const normalized = path.posix.normalize(`/${segments.join('/')}`);
  if (normalized === '/') return '';
  return toVirtualRelative(normalized);
}

function joinLeaseRelativePath(parent: string, child: string): string {
  return [parent, child].filter(Boolean).join('/');
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') && value !== '/' ? value.slice(0, -1) : value;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
