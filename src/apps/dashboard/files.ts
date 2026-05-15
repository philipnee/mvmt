import fsp from 'fs/promises';
import path from 'path';
import { LocalFolderMountConfig } from '../../config/schema.js';
import { MountRegistry } from '../../context/mount-registry.js';
import { isGloballyDeniedPath, matchesConfiguredOrGlobalPattern, matchesPathPatterns } from '../../context/path-policy.js';

export interface DashboardFileEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  mtimeMs: number;
  writeAccess: boolean;
  unavailable?: boolean;
}

export interface DashboardFileListing {
  path: string;
  type: 'directory' | 'file';
  size: number;
  mtimeMs: number;
  writeAccess: boolean;
  entries: DashboardFileEntry[];
}

export interface DashboardFileTarget {
  virtualPath: string;
  realPath: string;
  parentRealPath: string;
  filename: string;
  type: 'directory' | 'file';
  size: number;
  mtimeMs: number;
  writeAccess: boolean;
}

export async function listDashboardFiles(
  mounts: readonly LocalFolderMountConfig[],
  requestPath = '/',
): Promise<DashboardFileListing> {
  const normalizedPath = normalizeDashboardPath(requestPath);
  const enabledMounts = mounts.filter((mount) => mount.enabled !== false);
  if (normalizedPath === '/') {
    const entries: DashboardFileEntry[] = [];
    for (const mount of enabledMounts) {
      try {
        const stat = await fsp.stat(mount.root);
        if (!stat.isDirectory() && !stat.isFile()) continue;
        entries.push({
          name: mount.path.split('/').filter(Boolean).join('/') || mount.name,
          path: mount.path,
          type: stat.isDirectory() ? 'directory' : 'file',
          size: stat.isDirectory() ? 0 : stat.size,
          mtimeMs: stat.mtimeMs,
          writeAccess: Boolean(mount.writeAccess),
        });
      } catch {
        // Stale mount roots stay hidden in the dashboard.
      }
    }
    entries.sort(compareDashboardEntries);
    return { path: '/', type: 'directory', size: 0, mtimeMs: 0, writeAccess: false, entries };
  }

  const target = await resolveDashboardFileTarget(enabledMounts, normalizedPath);
  if (target.type === 'file') {
    return {
      path: target.virtualPath,
      type: 'file',
      size: target.size,
      mtimeMs: target.mtimeMs,
      writeAccess: target.writeAccess,
      entries: [],
    };
  }

  const dirents = await fsp.readdir(target.realPath, { withFileTypes: true });
  const entries: DashboardFileEntry[] = [];
  for (const dirent of dirents) {
    const childPath = `${stripTrailingSlash(target.virtualPath)}/${dirent.name}`;
    try {
      const child = await resolveDashboardFileTarget(enabledMounts, childPath);
      entries.push({
        name: dirent.name,
        path: child.virtualPath,
        type: child.type,
        size: child.type === 'directory' ? 0 : child.size,
        mtimeMs: child.mtimeMs,
        writeAccess: child.writeAccess,
      });
    } catch {
      // Excluded, denied, broken, or escaping children stay invisible.
    }
  }
  entries.sort(compareDashboardEntries);
  return {
    path: target.virtualPath,
    type: 'directory',
    size: 0,
    mtimeMs: target.mtimeMs,
    writeAccess: target.writeAccess,
    entries,
  };
}

export async function resolveDashboardFileTarget(
  mounts: readonly LocalFolderMountConfig[],
  requestPath: string,
): Promise<DashboardFileTarget> {
  const registry = new MountRegistry([...mounts]);
  const normalizedPath = normalizeDashboardPath(requestPath);
  const resolved = registry.resolve(normalizedPath);
  const stat = await fsp.stat(resolved.realPath);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`${normalizedPath} is not a file or directory`);
  const policyPath = resolved.relativePath || path.basename(resolved.realPath);
  if (matchesConfiguredOrGlobalPattern(policyPath, resolved.mount.config.exclude)) {
    throw new Error(`${normalizedPath} is excluded`);
  }
  const mountRootRealPath = await fsp.realpath(resolved.mount.root);
  const realPath = await fsp.realpath(resolved.realPath);
  if (!isWithin(mountRootRealPath, realPath)) {
    throw new Error(`${normalizedPath} escapes mount root`);
  }
  if (isGloballyDeniedPath(policyPath, realPath)) {
    throw new Error(`${normalizedPath} is globally denied`);
  }
  return {
    virtualPath: resolved.virtualPath,
    realPath,
    parentRealPath: await fsp.realpath(path.dirname(resolved.realPath)),
    filename: path.basename(resolved.realPath),
    type: stat.isDirectory() ? 'directory' : 'file',
    size: stat.isDirectory() ? 0 : stat.size,
    mtimeMs: stat.mtimeMs,
    writeAccess: Boolean(resolved.mount.config.writeAccess),
  };
}

export async function assertDashboardWriteAllowed(
  mounts: readonly LocalFolderMountConfig[],
  requestPath: string,
): Promise<DashboardFileTarget> {
  const target = await resolveDashboardFileTarget(mounts, requestPath);
  if (!target.writeAccess) throw new Error(`${target.virtualPath} is read-only`);
  const registry = new MountRegistry([...mounts]);
  const resolved = registry.resolve(target.virtualPath);
  const policyPath = resolved.relativePath || target.filename;
  if (matchesPathPatterns(policyPath, resolved.mount.config.protect)) {
    throw new Error(`${target.virtualPath} is protected`);
  }
  return target;
}

export function normalizeDashboardPath(inputPath: string): string {
  const normalized = inputPath.trim().replaceAll('\\', '/').split('/').filter(Boolean).join('/');
  return normalized ? `/${normalized}` : '/';
}

function compareDashboardEntries(a: DashboardFileEntry, b: DashboardFileEntry): number {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
